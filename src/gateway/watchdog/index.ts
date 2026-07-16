import { checkHeartbeats } from './heartbeat';
import { cleanupOldRecords } from './cleanup';
import type { GatewayConfig } from '@gateway/config';
import {
    markGatewayActivity,
    markGatewayFailure,
    markGatewaySuccess,
} from '../health';

export class Watchdog {
    private stopped = false;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private cleanupTimer: ReturnType<typeof setInterval> | null = null;
    private checkingHeartbeats = false;
    private cleaning = false;
    private heartbeatCheckPromise: Promise<void> | null = null;
    private cleanupPromise: Promise<void> | null = null;

    constructor(
        private cfg: GatewayConfig,
        private isOwnedRun: (taskId: number, runId: number) => boolean = () => false,
    ) {}

    start() {
        this.stopped = false;
        markGatewayActivity('watchdog');
        this.heartbeatTimer = setInterval(
            () => this.runHeartbeatCheck(),
            this.cfg.watchdog.checkIntervalMs,
        );
        this.cleanupTimer = setInterval(
            () => this.runCleanup(),
            this.cfg.watchdog.cleanupIntervalMs,
        );
        void this.runHeartbeatCheck();
    }

    async stop(): Promise<void> {
        this.stopped = true;
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
        await Promise.all([
            this.heartbeatCheckPromise,
            this.cleanupPromise,
        ]);
    }

    private runHeartbeatCheck(): Promise<void> {
        if (this.stopped) return Promise.resolve();
        if (this.heartbeatCheckPromise) return this.heartbeatCheckPromise;
        this.checkingHeartbeats = true;
        markGatewayActivity('watchdog');
        const operation = (async () => {
            try {
                const result = await checkHeartbeats(
                    this.cfg.watchdog.heartbeatTimeoutMs,
                    this.isOwnedRun,
                    () => this.stopped,
                );
                if (result.quarantinedRuns > 0 || result.failedRuns > 0) {
                    throw new Error(
                        `Watchdog 有 ${result.quarantinedRuns} 个隔离 run、${result.failedRuns} 个恢复失败 run`,
                    );
                }
                markGatewaySuccess('watchdog');
            } catch (err) {
                markGatewayFailure('watchdog', err);
                console.error(JSON.stringify({
                    ts: new Date().toISOString(),
                    level: 'error',
                    msg: 'watchdog heartbeat check failed',
                    error: err instanceof Error ? err.message : String(err),
                }));
            } finally {
                this.checkingHeartbeats = false;
            }
        })();
        this.heartbeatCheckPromise = operation.finally(() => {
            this.heartbeatCheckPromise = null;
        });
        return this.heartbeatCheckPromise;
    }

    private runCleanup(): Promise<void> {
        if (this.stopped) return Promise.resolve();
        if (this.cleanupPromise) return this.cleanupPromise;
        this.cleaning = true;
        markGatewayActivity('watchdogCleanup');
        const operation = (async () => {
            try {
                await cleanupOldRecords(
                    this.cfg.watchdog.retentionDays,
                    () => this.stopped,
                );
                markGatewaySuccess('watchdogCleanup');
            } catch (err) {
                markGatewayFailure('watchdogCleanup', err);
                console.error(JSON.stringify({
                    ts: new Date().toISOString(),
                    level: 'error',
                    msg: 'watchdog cleanup failed',
                    error: err instanceof Error ? err.message : String(err),
                }));
            } finally {
                this.cleaning = false;
            }
        })();
        this.cleanupPromise = operation.finally(() => {
            this.cleanupPromise = null;
        });
        return this.cleanupPromise;
    }
}
