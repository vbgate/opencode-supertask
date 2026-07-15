import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export interface GatewayConfig {
    configVersion: 2;
    worker: {
        maxConcurrency: number;
        pollIntervalMs: number;
        heartbeatIntervalMs: number;
        taskTimeoutMs: number;
        shutdownGracePeriodMs: number;
    };
    scheduler: {
        enabled: boolean;
        checkIntervalMs: number;
    };
    watchdog: {
        heartbeatTimeoutMs: number;
        checkIntervalMs: number;
        cleanupIntervalMs: number;
        retentionDays: number;
    };
    dashboard: {
        enabled: boolean;
        port: number;
    };
}

const DEFAULT_CONFIG: GatewayConfig = {
    configVersion: 2,
    worker: {
        maxConcurrency: 2,
        pollIntervalMs: 1000,
        heartbeatIntervalMs: 30_000,
        taskTimeoutMs: 1_800_000,
        shutdownGracePeriodMs: 30_000,
    },
    scheduler: {
        enabled: true,
        checkIntervalMs: 1000,
    },
    watchdog: {
        heartbeatTimeoutMs: 600_000,
        checkIntervalMs: 60_000,
        cleanupIntervalMs: 86_400_000,
        retentionDays: 30,
    },
    dashboard: {
        enabled: true,
        port: 4680,
    },
};

const CONFIG_PATH = join(homedir(), '.config/opencode/supertask.json');

function objectAt(value: unknown, path: string): Record<string, unknown> {
    if (value === undefined) return {};
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${path} 必须是对象`);
    }
    return value as Record<string, unknown>;
}

function integerAt(
    source: Record<string, unknown>,
    key: string,
    fallback: number,
    min: number,
    max: number,
    path: string,
): number {
    const value = source[key];
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
        throw new Error(`${path}.${key} 必须是 ${min} 到 ${max} 之间的整数`);
    }
    return value;
}

function booleanAt(
    source: Record<string, unknown>,
    key: string,
    fallback: boolean,
    path: string,
): boolean {
    const value = source[key];
    if (value === undefined) return fallback;
    if (typeof value !== 'boolean') throw new Error(`${path}.${key} 必须是布尔值`);
    return value;
}

export function validateConfig(input: unknown): GatewayConfig {
    const root = objectAt(input, 'config');
    const version = root.configVersion ?? 1;
    if (version !== 1 && version !== 2) {
        throw new Error('config.configVersion 只支持 1 或 2');
    }

    const worker = objectAt(root.worker, 'worker');
    const scheduler = objectAt(root.scheduler, 'scheduler');
    const watchdog = objectAt(root.watchdog, 'watchdog');
    const dashboard = objectAt(root.dashboard, 'dashboard');

    const heartbeatIntervalMs = integerAt(worker, 'heartbeatIntervalMs', DEFAULT_CONFIG.worker.heartbeatIntervalMs, 1000, 3_600_000, 'worker');
    const heartbeatTimeoutMs = integerAt(watchdog, 'heartbeatTimeoutMs', DEFAULT_CONFIG.watchdog.heartbeatTimeoutMs, 1000, 86_400_000, 'watchdog');

    let checkIntervalMs: number;
    let cleanupIntervalMs: number;
    if (version === 1 && watchdog.checkIntervalMs === undefined && watchdog.cleanupIntervalMs !== undefined) {
        checkIntervalMs = integerAt(watchdog, 'cleanupIntervalMs', DEFAULT_CONFIG.watchdog.checkIntervalMs, 1000, 3_600_000, 'watchdog');
        cleanupIntervalMs = DEFAULT_CONFIG.watchdog.cleanupIntervalMs;
    } else {
        checkIntervalMs = integerAt(watchdog, 'checkIntervalMs', DEFAULT_CONFIG.watchdog.checkIntervalMs, 1000, 3_600_000, 'watchdog');
        cleanupIntervalMs = integerAt(watchdog, 'cleanupIntervalMs', DEFAULT_CONFIG.watchdog.cleanupIntervalMs, 60_000, 604_800_000, 'watchdog');
    }

    if (heartbeatIntervalMs >= heartbeatTimeoutMs) {
        throw new Error('worker.heartbeatIntervalMs 必须小于 watchdog.heartbeatTimeoutMs');
    }
    if (checkIntervalMs > heartbeatTimeoutMs) {
        throw new Error('watchdog.checkIntervalMs 不能大于 watchdog.heartbeatTimeoutMs');
    }

    return {
        configVersion: 2,
        worker: {
            maxConcurrency: integerAt(worker, 'maxConcurrency', DEFAULT_CONFIG.worker.maxConcurrency, 1, 64, 'worker'),
            pollIntervalMs: integerAt(worker, 'pollIntervalMs', DEFAULT_CONFIG.worker.pollIntervalMs, 50, 60_000, 'worker'),
            heartbeatIntervalMs,
            taskTimeoutMs: integerAt(worker, 'taskTimeoutMs', DEFAULT_CONFIG.worker.taskTimeoutMs, 1000, 604_800_000, 'worker'),
            shutdownGracePeriodMs: integerAt(worker, 'shutdownGracePeriodMs', DEFAULT_CONFIG.worker.shutdownGracePeriodMs, 0, 3_600_000, 'worker'),
        },
        scheduler: {
            enabled: booleanAt(scheduler, 'enabled', DEFAULT_CONFIG.scheduler.enabled, 'scheduler'),
            checkIntervalMs: integerAt(scheduler, 'checkIntervalMs', DEFAULT_CONFIG.scheduler.checkIntervalMs, 100, 60_000, 'scheduler'),
        },
        watchdog: {
            heartbeatTimeoutMs,
            checkIntervalMs,
            cleanupIntervalMs,
            retentionDays: integerAt(watchdog, 'retentionDays', DEFAULT_CONFIG.watchdog.retentionDays, 1, 3650, 'watchdog'),
        },
        dashboard: {
            enabled: booleanAt(dashboard, 'enabled', DEFAULT_CONFIG.dashboard.enabled, 'dashboard'),
            port: integerAt(dashboard, 'port', DEFAULT_CONFIG.dashboard.port, 1, 65_535, 'dashboard'),
        },
    };
}

export function loadConfig(path = CONFIG_PATH): GatewayConfig {
    if (!existsSync(path)) return validateConfig({ configVersion: 2 });

    try {
        return validateConfig(JSON.parse(readFileSync(path, 'utf-8')) as unknown);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`无法读取配置 ${path}: ${message}`);
    }
}

export { CONFIG_PATH, DEFAULT_CONFIG };
