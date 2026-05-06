import { checkHeartbeats } from './heartbeat';
import { cleanupOldRecords } from './cleanup';
import type { GatewayConfig } from '@gateway/config';

export class Watchdog {
    private stopped = false;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private cleanupTimer: ReturnType<typeof setInterval> | null = null;

    constructor(private cfg: GatewayConfig) {}

    start() {
        this.stopped = false;
        this.heartbeatTimer = setInterval(
            () => this.runHeartbeatCheck(),
            this.cfg.watchdog.cleanupIntervalMs,
        );
        this.cleanupTimer = setInterval(
            () => this.runCleanup(),
            this.cfg.watchdog.cleanupIntervalMs * 24 * 60,
        );
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
        if (this.stopped) return;
        try {
            await checkHeartbeats(this.cfg.watchdog.heartbeatTimeoutMs);
        } catch (err) {
            console.error(JSON.stringify({
                ts: new Date().toISOString(),
                level: 'error',
                msg: 'watchdog heartbeat check failed',
                error: err instanceof Error ? err.message : String(err),
            }));
        }
    }

    private async runCleanup() {
        if (this.stopped) return;
        try {
            await cleanupOldRecords(this.cfg.watchdog.retentionDays);
        } catch (err) {
            console.error(JSON.stringify({
                ts: new Date().toISOString(),
                level: 'error',
                msg: 'watchdog cleanup failed',
                error: err instanceof Error ? err.message : String(err),
            }));
        }
    }
}
