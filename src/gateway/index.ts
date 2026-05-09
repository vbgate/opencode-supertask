import { sqlite } from '@core/db';
import { loadConfig } from './config';
import { WorkerEngine } from '@worker/index';
import { Watchdog } from './watchdog';
import { Scheduler } from './scheduler';
import { closeDb } from '@core/db';
import { TaskService } from '@core/services/task.service';
import { TaskRunService } from '@core/services/task-run.service';

// gateway_lock.heartbeat_at / acquired_at 单位：毫秒（Date.now()）
// 超过此阈值未心跳则视为锁持有者已死亡
const STALE_THRESHOLD_MS = 30_000;

function acquireLock(): boolean {
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
            if (now - existing.heartbeat_at < STALE_THRESHOLD_MS) {
                sqlite.exec('ROLLBACK');
                console.error(JSON.stringify({
                    ts: new Date().toISOString(),
                    level: 'fatal',
                    msg: 'another Gateway instance is already running',
                    existingPid: existing.pid,
                }));
                return false;
            }

            sqlite.exec('DELETE FROM gateway_lock WHERE id = 1');
        }

        sqlite.exec(
            'INSERT INTO gateway_lock (id, pid, acquired_at, heartbeat_at) VALUES (1, ?, ?, ?)',
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

function releaseLock() {
    try {
        sqlite.exec('DELETE FROM gateway_lock WHERE pid = ?', [process.pid]);
    } catch {}
}

function updateLockHeartbeat() {
    try {
        sqlite.exec(
            'UPDATE gateway_lock SET heartbeat_at = ? WHERE pid = ?',
            [Date.now(), process.pid],
        );
    } catch {}
}

async function main() {
    console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg: 'SuperTask Gateway starting', pid: process.pid }));

    if (!acquireLock()) {
        process.exit(1);
    }

    const heartbeatTimer = setInterval(updateLockHeartbeat, 10_000);
    heartbeatTimer.unref();

    const cfg = loadConfig();
    const worker = new WorkerEngine(cfg);
    const watchdog = new Watchdog(cfg);
    const scheduler = new Scheduler(cfg);

    worker.start();
    watchdog.start();
    await scheduler.start();

    if (cfg.dashboard.enabled) {
        const { dashboardApp } = await import('@web/index');
        Bun.serve({
            port: cfg.dashboard.port,
            fetch(req) {
                const url = new URL(req.url);
                if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1' && url.hostname !== '::1') {
                    return new Response('Forbidden', { status: 403 });
                }
                return dashboardApp.fetch(req);
            },
        });
        console.log(JSON.stringify({
            ts: new Date().toISOString(),
            level: 'info',
            msg: 'Dashboard started',
            url: `http://localhost:${cfg.dashboard.port}`,
        }));
    }

    console.log(JSON.stringify({
        ts: new Date().toISOString(),
        level: 'info',
        msg: 'Gateway started',
        maxConcurrency: cfg.worker.maxConcurrency,
        schedulerEnabled: cfg.scheduler.enabled,
    }));

    let shuttingDown = false;
    const shutdown = async (signal: string) => {
        if (shuttingDown) return;
        shuttingDown = true;

        console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg: `received ${signal}, shutting down...` }));

        clearInterval(heartbeatTimer);
        scheduler.stop();
        watchdog.stop();

        const runningIds = worker.getRunningTaskIds();
        await worker.stop();

        if (runningIds.length > 0) {
            const resetCount = await TaskService.resetRunningToPending(runningIds);
            console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg: 'reset running tasks to pending', count: resetCount }));
        }

        const allRunningRuns = await TaskRunService.getAllRunningRuns();
        for (const run of allRunningRuns) {
            await TaskRunService.fail(run.id, 'Gateway shutdown');
        }

        releaseLock();
        closeDb();

        console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg: 'Gateway stopped' }));
        process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    process.on('uncaughtException', (err) => {
        console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'fatal', msg: 'uncaughtException', error: err.message, stack: err.stack }));
        process.exit(1);
    });

    process.on('unhandledRejection', (reason) => {
        console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'fatal', msg: 'unhandledRejection', reason: String(reason) }));
        process.exit(1);
    });
}

export { main };

if (import.meta.main) {
    main();
}
