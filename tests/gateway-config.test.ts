import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig, validateConfig } from '../src/gateway/config';

const tempDirs: string[] = [];

afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function configFile(contents: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'supertask-config-'));
    tempDirs.push(dir);
    const path = join(dir, 'supertask.json');
    writeFileSync(path, contents);
    return path;
}

describe('Gateway 配置', () => {
    test('部分配置只覆盖已声明字段，未知和失效字段不会混入运行时配置', () => {
        const config = validateConfig({
            worker: { maxConcurrency: 5 },
            scheduler: { catchUp: 'all' },
            logging: { format: 'text' },
            unknown: true,
        });

        expect(config.worker.maxConcurrency).toBe(5);
        expect(config.worker.pollIntervalMs).toBe(1000);
        expect(config.worker.shutdownGracePeriodMs).toBe(30_000);
        expect('catchUp' in config.scheduler).toBe(false);
        expect('logging' in config).toBe(false);
        expect('unknown' in config).toBe(false);
    });

    test('旧版 cleanupIntervalMs 自动迁移为心跳检查间隔', () => {
        const config = validateConfig({ watchdog: { cleanupIntervalMs: 45_000 } });

        expect(config.watchdog.checkIntervalMs).toBe(45_000);
        expect(config.watchdog.cleanupIntervalMs).toBe(86_400_000);
    });

    test('新版可分别配置心跳检查与数据清理间隔', () => {
        const config = validateConfig({
            configVersion: 2,
            watchdog: { checkIntervalMs: 20_000, cleanupIntervalMs: 3_600_000 },
        });

        expect(config.watchdog.checkIntervalMs).toBe(20_000);
        expect(config.watchdog.cleanupIntervalMs).toBe(3_600_000);
    });

    test('拒绝越界、非整数和互相冲突的配置', () => {
        expect(() => validateConfig({ worker: { maxConcurrency: 0 } })).toThrow('worker.maxConcurrency');
        expect(() => validateConfig({ dashboard: { port: 70000 } })).toThrow('dashboard.port');
        expect(() => validateConfig({ worker: { pollIntervalMs: 10.5 } })).toThrow('worker.pollIntervalMs');
        expect(() => validateConfig({ worker: { shutdownGracePeriodMs: -1 } })).toThrow('worker.shutdownGracePeriodMs');
        expect(() => validateConfig({
            worker: { heartbeatIntervalMs: 10_000 },
            watchdog: { heartbeatTimeoutMs: 5_000 },
        })).toThrow('heartbeatIntervalMs');
    });

    test('配置文件损坏时明确报错，不静默回退默认值', () => {
        const path = configFile('{broken');
        expect(() => loadConfig(path)).toThrow(`无法读取配置 ${path}`);
    });
});
