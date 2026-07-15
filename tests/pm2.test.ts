import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
    ensureGateway,
    getPackageVersion,
    installMacLaunchAgent,
    isGatewayRunning,
    resolveGatewayEntry,
    upgrade,
} from '../src/daemon/pm2';

const dirs: string[] = [];
const originalEnv = {
    pm2: process.env.SUPERTASK_PM2_BIN,
    bun: process.env.SUPERTASK_BUN_BIN,
    entry: process.env.SUPERTASK_GATEWAY_ENTRY,
    version: process.env.SUPERTASK_VERSION_FILE,
    db: process.env.SUPERTASK_DB_PATH,
    readyTimeout: process.env.SUPERTASK_GATEWAY_READY_TIMEOUT_MS,
    killTimeout: process.env.SUPERTASK_PM2_KILL_TIMEOUT_MS,
    launchAgent: process.env.SUPERTASK_LAUNCH_AGENT_PATH,
    launchctl: process.env.SUPERTASK_LAUNCHCTL_BIN,
};

afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    restoreEnv('SUPERTASK_PM2_BIN', originalEnv.pm2);
    restoreEnv('SUPERTASK_BUN_BIN', originalEnv.bun);
    restoreEnv('SUPERTASK_GATEWAY_ENTRY', originalEnv.entry);
    restoreEnv('SUPERTASK_VERSION_FILE', originalEnv.version);
    restoreEnv('SUPERTASK_DB_PATH', originalEnv.db);
    restoreEnv('SUPERTASK_GATEWAY_READY_TIMEOUT_MS', originalEnv.readyTimeout);
    restoreEnv('SUPERTASK_PM2_KILL_TIMEOUT_MS', originalEnv.killTimeout);
    restoreEnv('SUPERTASK_LAUNCH_AGENT_PATH', originalEnv.launchAgent);
    restoreEnv('SUPERTASK_LAUNCHCTL_BIN', originalEnv.launchctl);
});

function restoreEnv(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}

describe('PM2 Gateway 管理', () => {
    test('macOS 用户级 LaunchAgent 使用 pm2 resurrect 且无需 sudo', () => {
        const dir = mkdtempSync(join(tmpdir(), 'supertask-launch-agent-'));
        dirs.push(dir);
        const fakePm2 = join(dir, 'pm2 & tool');
        const fakeLaunchctl = join(dir, 'launchctl');
        const launchctlLog = join(dir, 'launchctl.jsonl');
        const plist = join(dir, 'LaunchAgents', 'supertask.plist');
        writeFileSync(fakePm2, '');
        writeFileSync(fakeLaunchctl, `#!/usr/bin/env bun
import { appendFileSync } from 'fs';
appendFileSync(${JSON.stringify(launchctlLog)}, JSON.stringify(Bun.argv.slice(2)) + '\\n');
`);
        chmodSync(fakeLaunchctl, 0o755);
        process.env.SUPERTASK_PM2_BIN = fakePm2;
        process.env.SUPERTASK_LAUNCHCTL_BIN = fakeLaunchctl;
        process.env.SUPERTASK_LAUNCH_AGENT_PATH = plist;

        expect(installMacLaunchAgent()).toBe(plist);
        const contents = readFileSync(plist, 'utf8');
        expect(contents).toContain('com.supertask.pm2-resurrect');
        expect(contents).toContain(`${fakePm2.replace('&', '&amp;')}`);
        expect(contents).toContain('<string>resurrect</string>');
        const calls = readFileSync(launchctlLog, 'utf8').trim().split('\n')
            .map((line) => JSON.parse(line) as string[]);
        expect(calls).toEqual([
            ['bootout', `gui/${process.getuid()}/com.supertask.pm2-resurrect`],
            ['bootstrap', `gui/${process.getuid()}`, plist],
        ]);
    });

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
        const dbPath = join(dir, 'tasks.db');
        writeFileSync(gateway, '');
        writeFileSync(fakePm2, `#!/usr/bin/env bun
import { appendFileSync, existsSync, writeFileSync } from 'fs';
import { Database } from 'bun:sqlite';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('6.0.0'); process.exit(0); }
if (args[0] === 'jlist') {
    console.log(existsSync(${JSON.stringify(state)}) ? JSON.stringify([{ name: 'supertask-gateway', pid: 4242, pm2_env: { status: 'online' } }]) : '[]');
    process.exit(0);
}
if (args[0] === 'start') {
    writeFileSync(${JSON.stringify(state)}, 'online');
    const db = new Database(${JSON.stringify(dbPath)});
    db.exec('CREATE TABLE IF NOT EXISTS gateway_lock (id INTEGER PRIMARY KEY, pid INTEGER NOT NULL, acquired_at INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL, ready_at INTEGER)');
    db.query('INSERT OR REPLACE INTO gateway_lock (id, pid, acquired_at, heartbeat_at, ready_at) VALUES (1, ?, ?, ?, ?)').run(4242, Date.now(), Date.now(), Date.now());
    db.close();
}
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
`);
        chmodSync(fakePm2, 0o755);

        process.env.SUPERTASK_PM2_BIN = fakePm2;
        process.env.SUPERTASK_BUN_BIN = '/tmp/bun executable';
        process.env.SUPERTASK_GATEWAY_ENTRY = gateway;
        process.env.SUPERTASK_VERSION_FILE = versionFile;
        process.env.SUPERTASK_DB_PATH = dbPath;
        process.env.SUPERTASK_GATEWAY_READY_TIMEOUT_MS = '200';
        process.env.SUPERTASK_PM2_KILL_TIMEOUT_MS = '35000';

        expect(ensureGateway()).toEqual({ ok: true, action: 'started' });
        expect(isGatewayRunning()).toBe(true);
        const calls = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]);
        expect(calls[0]).toEqual([
            'start', '/tmp/bun executable', '--name', 'supertask-gateway', '--interpreter', 'none',
            '--restart-delay', '5000', '--max-restarts', '30', '--kill-timeout', '35000', '--', gateway,
        ]);
        expect(calls[1]).toEqual(['save']);
        expect(readFileSync(versionFile, 'utf8')).toBe(getPackageVersion());
    });

    test('PM2 online 但没有匹配的 Gateway ready 心跳时判定为未运行', () => {
        const dir = mkdtempSync(join(tmpdir(), 'supertask-pm2-unready-'));
        dirs.push(dir);
        const fakePm2 = join(dir, 'pm2');
        const gateway = join(dir, 'gateway.ts');
        const dbPath = join(dir, 'tasks.db');
        writeFileSync(gateway, '');
        writeFileSync(fakePm2, `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('6.0.0'); process.exit(0); }
if (args[0] === 'jlist') { console.log(JSON.stringify([{ name: 'supertask-gateway', pid: 4242, pm2_env: { status: 'online' } }])); process.exit(0); }
if (args[0] === 'start') process.exit(0);
`);
        chmodSync(fakePm2, 0o755);

        process.env.SUPERTASK_PM2_BIN = fakePm2;
        process.env.SUPERTASK_BUN_BIN = '/tmp/bun';
        process.env.SUPERTASK_GATEWAY_ENTRY = gateway;
        process.env.SUPERTASK_DB_PATH = dbPath;
        process.env.SUPERTASK_GATEWAY_READY_TIMEOUT_MS = '50';
        process.env.SUPERTASK_PM2_KILL_TIMEOUT_MS = '35000';

        expect(isGatewayRunning()).toBe(false);
        expect(() => ensureGateway()).toThrow('未在限定时间内就绪');
    });

    test('升级时用已安装新包的 Gateway 入口和版本替换旧进程', () => {
        const dir = mkdtempSync(join(tmpdir(), 'supertask-pm2-upgrade-'));
        dirs.push(dir);
        const fakePm2 = join(dir, 'pm2');
        const state = join(dir, 'state');
        const log = join(dir, 'calls.jsonl');
        const oldGateway = join(dir, 'old-gateway.ts');
        const newGateway = join(dir, 'new-gateway.js');
        const dbPath = join(dir, 'tasks.db');
        const versionFile = join(dir, 'version');
        writeFileSync(oldGateway, '');
        writeFileSync(newGateway, '');
        writeFileSync(state, 'online');
        writeFileSync(versionFile, '0.1.20');
        writeFileSync(fakePm2, `#!/usr/bin/env bun
import { appendFileSync, existsSync, rmSync, writeFileSync } from 'fs';
import { Database } from 'bun:sqlite';
const args = process.argv.slice(2);
if (args[0] === '--version') process.exit(0);
if (args[0] === 'jlist') {
    console.log(existsSync(${JSON.stringify(state)}) ? JSON.stringify([{ name: 'supertask-gateway', pid: 4242, pm2_env: { status: 'online' } }]) : '[]');
    process.exit(0);
}
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === 'delete') rmSync(${JSON.stringify(state)}, { force: true });
if (args[0] === 'start') {
    writeFileSync(${JSON.stringify(state)}, 'online');
    const db = new Database(${JSON.stringify(dbPath)});
    db.exec('CREATE TABLE IF NOT EXISTS gateway_lock (id INTEGER PRIMARY KEY, pid INTEGER NOT NULL, acquired_at INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL, ready_at INTEGER)');
    db.query('INSERT OR REPLACE INTO gateway_lock (id, pid, acquired_at, heartbeat_at, ready_at) VALUES (1, ?, ?, ?, ?)').run(4242, Date.now(), Date.now(), Date.now());
    db.close();
}
`);
        chmodSync(fakePm2, 0o755);
        process.env.SUPERTASK_PM2_BIN = fakePm2;
        process.env.SUPERTASK_BUN_BIN = '/tmp/bun';
        process.env.SUPERTASK_GATEWAY_ENTRY = oldGateway;
        process.env.SUPERTASK_DB_PATH = dbPath;
        process.env.SUPERTASK_VERSION_FILE = versionFile;
        process.env.SUPERTASK_GATEWAY_READY_TIMEOUT_MS = '100';
        process.env.SUPERTASK_PM2_KILL_TIMEOUT_MS = '35000';

        expect(upgrade({ gatewayEntry: newGateway, version: '0.1.21' })).toEqual({
            before: '0.1.20', after: '0.1.21', restarted: true,
        });
        const calls = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]);
        expect(calls.find((call) => call[0] === 'start')?.at(-1)).toBe(newGateway);
        expect(readFileSync(versionFile, 'utf8')).toBe('0.1.21');
    });

    test('新 Gateway 未就绪时恢复旧入口和旧版本', () => {
        const dir = mkdtempSync(join(tmpdir(), 'supertask-pm2-rollback-'));
        dirs.push(dir);
        const fakePm2 = join(dir, 'pm2');
        const state = join(dir, 'state');
        const log = join(dir, 'calls.jsonl');
        const oldGateway = join(dir, 'old-gateway.ts');
        const newGateway = join(dir, 'broken-gateway.js');
        const dbPath = join(dir, 'tasks.db');
        const versionFile = join(dir, 'version');
        writeFileSync(oldGateway, '');
        writeFileSync(newGateway, '');
        writeFileSync(state, 'online');
        writeFileSync(versionFile, '0.1.20');
        writeFileSync(fakePm2, `#!/usr/bin/env bun
import { appendFileSync, existsSync, rmSync, writeFileSync } from 'fs';
import { Database } from 'bun:sqlite';
const args = process.argv.slice(2);
if (args[0] === '--version') process.exit(0);
if (args[0] === 'jlist') {
    console.log(existsSync(${JSON.stringify(state)}) ? JSON.stringify([{ name: 'supertask-gateway', pid: 4242, pm2_env: { status: 'online' } }]) : '[]');
    process.exit(0);
}
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === 'delete') rmSync(${JSON.stringify(state)}, { force: true });
if (args[0] === 'start') {
    writeFileSync(${JSON.stringify(state)}, 'online');
    const db = new Database(${JSON.stringify(dbPath)});
    db.exec('CREATE TABLE IF NOT EXISTS gateway_lock (id INTEGER PRIMARY KEY, pid INTEGER NOT NULL, acquired_at INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL, ready_at INTEGER)');
    const readyAt = args.at(-1) === ${JSON.stringify(oldGateway)} ? Date.now() : null;
    db.query('INSERT OR REPLACE INTO gateway_lock (id, pid, acquired_at, heartbeat_at, ready_at) VALUES (1, ?, ?, ?, ?)').run(4242, Date.now(), Date.now(), readyAt);
    db.close();
}
`);
        chmodSync(fakePm2, 0o755);
        process.env.SUPERTASK_PM2_BIN = fakePm2;
        process.env.SUPERTASK_BUN_BIN = '/tmp/bun';
        process.env.SUPERTASK_GATEWAY_ENTRY = oldGateway;
        process.env.SUPERTASK_DB_PATH = dbPath;
        process.env.SUPERTASK_VERSION_FILE = versionFile;
        process.env.SUPERTASK_GATEWAY_READY_TIMEOUT_MS = '50';
        process.env.SUPERTASK_PM2_KILL_TIMEOUT_MS = '35000';

        expect(() => upgrade({ gatewayEntry: newGateway, version: '0.1.21' })).toThrow('已回滚到旧 Gateway');
        const starts = readFileSync(log, 'utf8').trim().split('\n')
            .map((line) => JSON.parse(line) as string[])
            .filter((call) => call[0] === 'start');
        expect(starts.map((call) => call.at(-1))).toEqual([newGateway, oldGateway]);
        expect(readFileSync(versionFile, 'utf8')).toBe('0.1.20');
        expect(isGatewayRunning()).toBe(true);
    });
});
