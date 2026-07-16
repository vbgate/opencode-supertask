import { sqlite } from '@core/db';

const LOCK_STALE_MS = 30_000;

type GatewayComponent = 'worker' | 'scheduler' | 'watchdog' | 'watchdogCleanup';

interface GatewayHealthConfig {
    workerPollIntervalMs: number;
    schedulerEnabled: boolean;
    schedulerCheckIntervalMs: number;
    watchdogCheckIntervalMs: number;
    watchdogCleanupIntervalMs: number;
}

interface HealthState {
    startedAt: number;
    config: GatewayHealthConfig;
    lastActivityAt: Record<GatewayComponent, number>;
    lastSuccessAt: Record<GatewayComponent, number>;
    consecutiveFailures: Record<GatewayComponent, number>;
    lastError: Record<GatewayComponent, { at: number; message: string } | null>;
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
            watchdogCleanup: now,
        },
        lastSuccessAt: {
            worker: now,
            scheduler: now,
            watchdog: now,
            watchdogCleanup: now,
        },
        consecutiveFailures: {
            worker: 0,
            scheduler: 0,
            watchdog: 0,
            watchdogCleanup: 0,
        },
        lastError: {
            worker: null,
            scheduler: null,
            watchdog: null,
            watchdogCleanup: null,
        },
    };
}

export function markGatewayActivity(component: GatewayComponent): void {
    if (state) state.lastActivityAt[component] = Date.now();
}

export function markGatewaySuccess(component: GatewayComponent): void {
    if (!state) return;
    const now = Date.now();
    state.lastActivityAt[component] = now;
    state.lastSuccessAt[component] = now;
    state.consecutiveFailures[component] = 0;
}

export function markGatewayFailure(component: GatewayComponent, error: unknown): void {
    if (!state) return;
    const now = Date.now();
    state.lastActivityAt[component] = now;
    state.consecutiveFailures[component] += 1;
    state.lastError[component] = {
        at: now,
        message: error instanceof Error ? error.message : String(error),
    };
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
    const consecutiveFailures = state?.consecutiveFailures[component] ?? 0;
    return {
        enabled,
        healthy: !enabled || (
            ageMs != null
            && ageMs <= maxAgeMs
            && consecutiveFailures === 0
        ),
        lastActivityAt,
        lastSuccessAt: state?.lastSuccessAt[component] ?? null,
        consecutiveFailures,
        lastError: state?.lastError[component] ?? null,
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
    const watchdogCleanup = componentStatus(
        'watchdogCleanup',
        true,
        Math.max((state?.config.watchdogCleanupIntervalMs ?? 86_400_000) * 2, 60_000),
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
        && watchdog.healthy
        && watchdogCleanup.healthy;

    return {
        status: healthy ? 'ok' as const : 'degraded' as const,
        pid: process.pid,
        uptimeMs: state ? Math.max(0, now - state.startedAt) : 0,
        lock,
        components: { worker, scheduler, watchdog, watchdogCleanup },
    };
}
