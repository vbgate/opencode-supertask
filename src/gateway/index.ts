import { sqlite } from '@core/db';
import { loadConfig } from './config';
import { WorkerEngine, assertWorkerProcessIsolationSupported } from '@worker/index';
import { Watchdog } from './watchdog';
import { Scheduler } from './scheduler';
import { closeDb } from '@core/db';
import { TaskService } from '@core/services/task.service';
import { initializeGatewayHealth, resetGatewayHealth } from './health';
import { identifyGatewayProcess, isProcessAlive } from '@core/process-control';
import { getPackageVersion } from '@core/package-version';

const STALE_THRESHOLD_MS = 30_000;

export interface GatewayShutdownFailure {
    step: string;
    error: string;
}

export async function runGatewayShutdownStep(
    failures: GatewayShutdownFailure[],
    step: string,
    operation: () => void | Promise<void>,
): Promise<void> {
    try {
        await operation();
    } catch (error) {
        failures.push({
            step,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

export function resolveGatewayShutdownExitCode(
    requestedExitCode: number,
    failures: GatewayShutdownFailure[],
): number {
    return failures.length > 0 ? 1 : requestedExitCode;
}

export function acquireLock(): boolean {
    const now = Date.now();
    const pid = process.pid;

    try {
        sqlite.exec('BEGIN IMMEDIATE');

        const existing = sqlite.prepare('SELECT id, pid, heartbeat_at FROM gateway_lock WHERE id = 1').get() as {
            id: number;
            pid: number;
            heartbeat_at: number;
        } | undefined;

        if (existing) {
            const lockHolderAlive = existing.pid !== pid && isProcessAlive(existing.pid);
            if (lockHolderAlive) {
                const identity = identifyGatewayProcess(existing.pid);
                const lockIsFresh = now - existing.heartbeat_at < STALE_THRESHOLD_MS;
                if (lockIsFresh || identity !== 'mismatch') {
                    sqlite.exec('ROLLBACK');
                    console.error(JSON.stringify({
                        ts: new Date().toISOString(),
                        level: 'fatal',
                        msg: 'another Gateway instance is already running',
                        existingPid: existing.pid,
                        identity,
                    }));
                    return false;
                }

                console.warn(JSON.stringify({
                    ts: new Date().toISOString(),
                    level: 'warn',
                    msg: 'taking over stale Gateway lock from a reused PID',
                    existingPid: existing.pid,
                }));
            }

            sqlite.exec('DELETE FROM gateway_lock WHERE id = 1');
        }

        sqlite.exec(
            'INSERT INTO gateway_lock (id, pid, acquired_at, heartbeat_at, ready_at) VALUES (1, ?, ?, ?, NULL)',
            [pid, now, now],
        );
        sqlite.exec('COMMIT');
        return true;
    } catch (err) {
        try { sqlite.exec('ROLLBACK'); } catch {}
        console.error(JSON.stringify({
            ts: new Date().toISOString(),
            level: 'fatal',
            msg: 'failed to acquire lock',
            error: err instanceof Error ? err.message : String(err),
        }));
        return false;
    }
}

export function releaseLock() {
    try {
        sqlite.exec('DELETE FROM gateway_lock WHERE pid = ?', [process.pid]);
    } catch {}
}

export function updateLockHeartbeat(): boolean {
    try {
        const result = sqlite.query(
            'UPDATE gateway_lock SET heartbeat_at = ? WHERE id = 1 AND pid = ?',
        ).run(Date.now(), process.pid);
        return result.changes === 1;
    } catch {
        return false;
    }
}

function markGatewayReady() {
    const now = Date.now();
    const result = sqlite.query(
        'UPDATE gateway_lock SET heartbeat_at = ?, ready_at = ?, version = ? WHERE id = 1 AND pid = ?',
    ).run(now, now, getPackageVersion(), process.pid);
    if (result.changes !== 1) {
        throw new Error('Gateway 在就绪前失去了数据库单实例锁');
    }
}

function markGatewayNotReady() {
    try {
        sqlite.exec('UPDATE gateway_lock SET ready_at = NULL WHERE pid = ?', [process.pid]);
    } catch {}
}

async function main() {
    console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg: 'SuperTask Gateway starting', pid: process.pid }));

    assertWorkerProcessIsolationSupported();

    if (!acquireLock()) {
        process.exit(1);
    }

    const cfg = loadConfig();
    const worker = new WorkerEngine(cfg);
    const watchdog = new Watchdog(cfg, (taskId, runId) => worker.ownsRun(taskId, runId));
    const scheduler = new Scheduler(cfg);
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let dashboardServer: ReturnType<typeof Bun.serve> | null = null;
    let shuttingDown = false;
    const shutdown = async (signal: string, exitCode = 0) => {
        if (shuttingDown) return;
        shuttingDown = true;
        const failures: GatewayShutdownFailure[] = [];

        try {
            console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg: `received ${signal}, shutting down...` }));

            if (heartbeatTimer) {
                clearInterval(heartbeatTimer);
                heartbeatTimer = null;
            }
            markGatewayNotReady();
            await runGatewayShutdownStep(failures, 'dashboard.stop', () => {
                const server = dashboardServer;
                dashboardServer = null;
                server?.stop(true);
            });
            await runGatewayShutdownStep(failures, 'scheduler.stop', () => scheduler.stop());
            await runGatewayShutdownStep(failures, 'watchdog.stop', () => watchdog.stop());

            let interruptedRuns: Awaited<ReturnType<WorkerEngine['stop']>> = [];
            await runGatewayShutdownStep(failures, 'worker.stop', async () => {
                interruptedRuns = await worker.stop(cfg.worker.shutdownGracePeriodMs);
            });

            let resetCount = 0;
            for (const run of interruptedRuns) {
                await runGatewayShutdownStep(
                    failures,
                    `task.interrupt:${run.taskId}:${run.runId}`,
                    async () => {
                        if (await TaskService.interruptRun(
                            run.taskId,
                            run.runId,
                            'Gateway shutdown after child exit',
                        )) {
                            resetCount += 1;
                        }
                    },
                );
            }
            if (resetCount > 0) {
                console.log(JSON.stringify({
                    ts: new Date().toISOString(),
                    level: 'info',
                    msg: 'reset confirmed interrupted tasks to pending',
                    count: resetCount,
                }));
            }

            await runGatewayShutdownStep(failures, 'lock.release', () => releaseLock());
            await runGatewayShutdownStep(failures, 'health.reset', () => resetGatewayHealth());
            await runGatewayShutdownStep(failures, 'database.close', () => closeDb());

            if (failures.length > 0) {
                console.error(JSON.stringify({
                    ts: new Date().toISOString(),
                    level: 'error',
                    msg: 'Gateway stopped with shutdown failures',
                    failures,
                }));
            } else {
                console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg: 'Gateway stopped' }));
            }
        } finally {
            process.exit(resolveGatewayShutdownExitCode(exitCode, failures));
        }
    };

    process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
    process.on('SIGINT', () => { void shutdown('SIGINT'); });

    process.on('uncaughtException', (err) => {
        console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'fatal', msg: 'uncaughtException', error: err.message, stack: err.stack }));
        void shutdown('uncaughtException', 1);
    });

    process.on('unhandledRejection', (reason) => {
        console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'fatal', msg: 'unhandledRejection', reason: String(reason) }));
        void shutdown('unhandledRejection', 1);
    });

    heartbeatTimer = setInterval(() => {
        if (updateLockHeartbeat()) return;
        console.error(JSON.stringify({
            ts: new Date().toISOString(),
            level: 'fatal',
            msg: 'Gateway lost its database lock and will stop',
            pid: process.pid,
        }));
        void shutdown('database lock lost', 1);
    }, 10_000);
    heartbeatTimer.unref();

    try {
        const recoveredOrphans = await TaskService.resetOrphanRunningToPending();
        if (recoveredOrphans > 0) {
            console.log(JSON.stringify({
                ts: new Date().toISOString(),
                level: 'warn',
                msg: 'reset orphan running tasks to pending',
                count: recoveredOrphans,
            }));
        }
        await TaskService.resolveBlockedDependencies();

        initializeGatewayHealth({
            workerPollIntervalMs: cfg.worker.pollIntervalMs,
            schedulerEnabled: cfg.scheduler.enabled,
            schedulerCheckIntervalMs: cfg.scheduler.checkIntervalMs,
            watchdogCheckIntervalMs: cfg.watchdog.checkIntervalMs,
            watchdogCleanupIntervalMs: cfg.watchdog.cleanupIntervalMs,
        });

        await scheduler.start();
        if (shuttingDown) return;

        if (cfg.dashboard.enabled) {
            const { dashboardApp, setDashboardRuntimeConfig } = await import('@web/index');
            if (shuttingDown) return;
            setDashboardRuntimeConfig(cfg);
            dashboardServer = Bun.serve({
                hostname: '127.0.0.1',
                port: cfg.dashboard.port,
                fetch: dashboardApp.fetch,
            });
            console.log(JSON.stringify({
                ts: new Date().toISOString(),
                level: 'info',
                msg: 'Dashboard started',
                url: `http://localhost:${cfg.dashboard.port}`,
            }));
        }

        watchdog.start();
        worker.start();
        markGatewayReady();

        console.log(JSON.stringify({
            ts: new Date().toISOString(),
            level: 'info',
            msg: 'Gateway started',
            maxConcurrency: cfg.worker.maxConcurrency,
            schedulerEnabled: cfg.scheduler.enabled,
        }));
    } catch (error) {
        console.error(JSON.stringify({
            ts: new Date().toISOString(),
            level: 'fatal',
            msg: 'Gateway startup failed',
            error: error instanceof Error ? error.message : String(error),
        }));
        await shutdown('startup failure', 1);
    }
}

export { main };

if (import.meta.main) {
    main();
}
