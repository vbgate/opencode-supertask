import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export interface GatewayConfig {
    worker: {
        maxConcurrency: number;
        pollIntervalMs: number;
        heartbeatIntervalMs: number;
        taskTimeoutMs: number;
    };
    scheduler: {
        enabled: boolean;
        checkIntervalMs: number;
        catchUp: 'next' | 'all' | 'latest';
    };
    watchdog: {
        heartbeatTimeoutMs: number;
        cleanupIntervalMs: number;
        retentionDays: number;
    };
    dashboard: {
        enabled: boolean;
        port: number;
    };
    logging: {
        level: string;
        format: 'json' | 'text';
    };
}

const DEFAULT_CONFIG: GatewayConfig = {
    worker: {
        maxConcurrency: 2,
        pollIntervalMs: 1000,
        heartbeatIntervalMs: 30000,
        taskTimeoutMs: 1800000,
    },
    scheduler: {
        enabled: true,
        checkIntervalMs: 1000,
        catchUp: 'next',
    },
    watchdog: {
        heartbeatTimeoutMs: 600000,
        cleanupIntervalMs: 60000,
        retentionDays: 30,
    },
    dashboard: {
        enabled: true,
        port: 4680,
    },
    logging: {
        level: 'info',
        format: 'json',
    },
};

const CONFIG_PATH = join(homedir(), '.config/opencode/supertask.json');

function deepMerge<T>(base: T, override: Record<string, unknown>): T {
    const result = { ...base } as Record<string, unknown>;
    for (const key of Object.keys(override)) {
        const val = (override as Record<string, unknown>)[key];
        if (val !== null && typeof val === 'object' && !Array.isArray(val) && key in result) {
            const baseVal = result[key];
            if (baseVal !== null && typeof baseVal === 'object' && !Array.isArray(baseVal)) {
                result[key] = deepMerge(baseVal as T, val as Record<string, unknown>);
                continue;
            }
        }
        if (val !== undefined) {
            result[key] = val;
        }
    }
    return result as T;
}

export function loadConfig(): GatewayConfig {
    if (!existsSync(CONFIG_PATH)) {
        return DEFAULT_CONFIG;
    }

    try {
        const raw = readFileSync(CONFIG_PATH, 'utf-8');
        const userConfig = JSON.parse(raw) as Record<string, unknown>;
        return deepMerge<GatewayConfig>(DEFAULT_CONFIG, userConfig);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'warn', msg: 'config load failed, using defaults', path: CONFIG_PATH, error: msg }));
        return DEFAULT_CONFIG;
    }
}

export { CONFIG_PATH };
