import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureGateway, getPackageVersion, resolveGatewayEntry } from '../src/daemon/pm2';

const dirs: string[] = [];
const originalEnv = {
    pm2: process.env.SUPERTASK_PM2_BIN,
    bun: process.env.SUPERTASK_BUN_BIN,
    entry: process.env.SUPERTASK_GATEWAY_ENTRY,
    version: process.env.SUPERTASK_VERSION_FILE,
};

afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    restoreEnv('SUPERTASK_PM2_BIN', originalEnv.pm2);
    restoreEnv('SUPERTASK_BUN_BIN', originalEnv.bun);
    restoreEnv('SUPERTASK_GATEWAY_ENTRY', originalEnv.entry);
    restoreEnv('SUPERTASK_VERSION_FILE', originalEnv.version);
});

function restoreEnv(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}

describe('PM2 Gateway 管理', () => {
    test('源码和构建目录都使用真实包版本与可用 Gateway 入口', () => {
        const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { version: string };
        expect(getPackageVersion()).toBe(pkg.version);
        expect(resolveGatewayEntry()).toBe(join(process.cwd(), 'src/gateway/index.ts'));
    });

    test('插件探测不到 pm2 时不执行全局安装', () => {
        process.env.SUPERTASK_PM2_BIN = join(tmpdir(), '不存在的-pm2');
        expect(ensureGateway()).toEqual({ ok: false, reason: 'pm2-not-installed' });
    });

    test('用参数数组注册 Gateway 并记录版本', () => {
        const dir = mkdtempSync(join(tmpdir(), 'supertask-pm2-'));
        dirs.push(dir);
        const log = join(dir, 'pm2-args.jsonl');
        const fakePm2 = join(dir, 'pm2');
        const state = join(dir, 'pm2-state');
        const gateway = join(dir, 'gateway entry.ts');
        const versionFile = join(dir, 'version');
        writeFileSync(gateway, '');
        writeFileSync(fakePm2, `#!/usr/bin/env bun
import { appendFileSync, existsSync, writeFileSync } from 'fs';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('6.0.0'); process.exit(0); }
if (args[0] === 'jlist') {
    console.log(existsSync(${JSON.stringify(state)}) ? JSON.stringify([{ name: 'supertask-gateway', pm2_env: { status: 'online' } }]) : '[]');
    process.exit(0);
}
if (args[0] === 'start') writeFileSync(${JSON.stringify(state)}, 'online');
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
`);
        chmodSync(fakePm2, 0o755);

        process.env.SUPERTASK_PM2_BIN = fakePm2;
        process.env.SUPERTASK_BUN_BIN = '/tmp/bun executable';
        process.env.SUPERTASK_GATEWAY_ENTRY = gateway;
        process.env.SUPERTASK_VERSION_FILE = versionFile;

        expect(ensureGateway()).toEqual({ ok: true, action: 'started' });
        const calls = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]);
        expect(calls[0]).toEqual([
            'start', '/tmp/bun executable', '--name', 'supertask-gateway', '--interpreter', 'none',
            '--restart-delay', '5000', '--max-restarts', '30', '--', gateway,
        ]);
        expect(calls[1]).toEqual(['save']);
        expect(readFileSync(versionFile, 'utf8')).toBe(getPackageVersion());
    });
});
