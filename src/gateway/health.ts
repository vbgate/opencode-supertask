import { sqlite } from '@core/db';

const LOCK_STALE_MS = 30_000;

type GatewayComponent = 'worker' | 'scheduler' | 'watchdog';

interface GatewayHealthConfig {
    workerPollIntervalMs: number;
    schedulerEnabled: boolean;
    schedulerCheckIntervalMs: number;
    watchdogCheckIntervalMs: number;
}

interface HealthState {
    startedAt: number;
    config: GatewayHealthConfig;
    lastActivityAt: Record<GatewayComponent, number>;
}

let state: HealthState | null = null;

export function initializeGatewayHealth(config: GatewayHealthConfig): void {
    const now = Date.now();
    state = {
        startedAt: now,
        config,
        lastActivityAt: {
            worker: now,
            scheduler: now,
            watchdog: now,
        },
    };
}

export function markGatewayActivity(component: GatewayComponent): void {
    if (state) state.lastActivityAt[component] = Date.now();
}

export function resetGatewayHealth(): void {
    state = null;
}

function componentStatus(
    component: GatewayComponent,
    enabled: boolean,
    maxAgeMs: number,
    now: number,
) {
    const lastActivityAt = state?.lastActivityAt[component] ?? null;
    const ageMs = lastActivityAt == null ? null : Math.max(0, now - lastActivityAt);
    return {
        enabled,
        healthy: !enabled || (ageMs != null && ageMs <= maxAgeMs),
        lastActivityAt,
        ageMs,
        maxAgeMs,
    };
}

export function getGatewayHealth(now = Date.now()) {
    const worker = componentStatus(
        'worker',
        true,
        Math.max((state?.config.workerPollIntervalMs ?? 1000) * 5, 5000),
        now,
    );
    const scheduler = componentStatus(
        'scheduler',
        state?.config.schedulerEnabled ?? false,
        Math.max((state?.config.schedulerCheckIntervalMs ?? 1000) * 5, 5000),
        now,
    );
    const watchdog = componentStatus(
        'watchdog',
        true,
        Math.max((state?.config.watchdogCheckIntervalMs ?? 60_000) * 3, 5000),
        now,
    );

    let lock: {
        pid: number | null;
        heartbeatAt: number | null;
        readyAt: number | null;
        ageMs: number | null;
        healthy: boolean;
    } = { pid: null, heartbeatAt: null, readyAt: null, ageMs: null, healthy: false };

    try {
        const row = sqlite.prepare(
            'SELECT pid, heartbeat_at, ready_at FROM gateway_lock WHERE id = 1',
        ).get() as { pid: number; heartbeat_at: number; ready_at: number | null } | undefined;
        if (row) {
            const ageMs = Math.max(0, now - row.heartbeat_at);
            lock = {
                pid: row.pid,
                heartbeatAt: row.heartbeat_at,
                readyAt: row.ready_at,
                ageMs,
                healthy: row.pid === process.pid && row.ready_at != null && ageMs < LOCK_STALE_MS,
            };
        }
    } catch {
    }

    const healthy = state != null
        && lock.healthy
        && worker.healthy
        && scheduler.healthy
        && watchdog.healthy;

    return {
        status: healthy ? 'ok' as const : 'degraded' as const,
        pid: process.pid,
        uptimeMs: state ? Math.max(0, now - state.startedAt) : 0,
        lock,
        components: { worker, scheduler, watchdog },
    };
}
