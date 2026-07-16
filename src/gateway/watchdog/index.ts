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

    constructor(private cfg: GatewayConfig) {}

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

    stop() {
        this.stopped = true;
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
    }

    private async runHeartbeatCheck() {
        if (this.stopped || this.checkingHeartbeats) return;
        this.checkingHeartbeats = true;
        markGatewayActivity('watchdog');
        try {
            const result = await checkHeartbeats(this.cfg.watchdog.heartbeatTimeoutMs);
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
    }

    private async runCleanup() {
        if (this.stopped) return;
        try {
            await cleanupOldRecords(this.cfg.watchdog.retentionDays);
        } catch (err) {
            markGatewayFailure('watchdog', err);
            console.error(JSON.stringify({
                ts: new Date().toISOString(),
                level: 'error',
                msg: 'watchdog cleanup failed',
                error: err instanceof Error ? err.message : String(err),
            }));
        }
    }
}
