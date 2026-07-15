import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { ensureGateway } from '../src/daemon/pm2';

const originalEnv = { ...process.env };
let dir = '';
let fakePm2 = '';
let dashboardPort = 0;
let gatewayLog = '';
let dbPath = '';
let statePath = '';

beforeAll(() => {
    execFileSync(process.execPath, ['run', 'build'], { cwd: process.cwd(), stdio: 'pipe' });

    dir = mkdtempSync(join(tmpdir(), 'supertask-package-e2e-'));
    const home = join(dir, 'home');
    const configDir = join(home, '.config/opencode');
    dbPath = join(dir, 'tasks.db');
    statePath = join(dir, 'pm2-state.json');
    gatewayLog = join(dir, 'gateway.log');
    const marker = join(dir, 'opencode-called');
    const fakeOpencode = join(dir, 'fake-opencode');
    fakePm2 = join(dir, 'pm2');
    dashboardPort = 30_000 + Math.floor(Math.random() * 10_000);

    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, 'supertask.json');
    writeFileSync(configPath, JSON.stringify({
        configVersion: 2,
        worker: {
            maxConcurrency: 1,
            pollIntervalMs: 50,
            heartbeatIntervalMs: 1000,
            taskTimeoutMs: 10_000,
            shutdownGracePeriodMs: 1000,
        },
        scheduler: { enabled: true, checkIntervalMs: 100 },
        watchdog: {
            heartbeatTimeoutMs: 5000,
            checkIntervalMs: 1000,
            cleanupIntervalMs: 60_000,
            retentionDays: 30,
        },
        dashboard: { enabled: true, port: dashboardPort },
    }));

    writeFileSync(fakeOpencode, `#!/usr/bin/env bun
await Bun.write(${JSON.stringify(marker)}, JSON.stringify(Bun.argv.slice(2)));
console.log(JSON.stringify({ sessionID: 'ses_package_e2e', message: '定时任务执行完成' }));
`);
    chmodSync(fakeOpencode, 0o755);

    writeFileSync(fakePm2, `#!/usr/bin/env bun
import { existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { spawn } from 'child_process';
const args = Bun.argv.slice(2);
const statePath = ${JSON.stringify(statePath)};
const logPath = ${JSON.stringify(gatewayLog)};
function state() {
    if (!existsSync(statePath)) return null;
    try { return JSON.parse(readFileSync(statePath, 'utf8')); } catch { return null; }
}
function alive(pid) {
    try { process.kill(pid, 0); return true; } catch { return false; }
}
if (args[0] === '--version') { console.log('6.0.0'); process.exit(0); }
if (args[0] === 'jlist') {
    const current = state();
    console.log(current && alive(current.pid)
        ? JSON.stringify([{ name: 'supertask-gateway', pid: current.pid, pm2_env: { status: 'online' } }])
        : '[]');
    process.exit(0);
}
if (args[0] === 'start') {
    const separator = args.indexOf('--');
    const out = openSync(logPath, 'a');
    writeFileSync(logPath, JSON.stringify({
        launcherPid: process.pid,
        configPath: process.env.SUPERTASK_CONFIG_PATH,
        dbPath: process.env.SUPERTASK_DB_PATH,
    }) + '\\n', { flag: 'a' });
    const child = spawn(args[1], args.slice(separator + 1), {
        detached: true,
        env: process.env,
        stdio: ['ignore', out, out],
    });
    child.unref();
    writeFileSync(statePath, JSON.stringify({ pid: child.pid }));
    process.exit(0);
}
if (args[0] === 'delete') {
    const current = state();
    if (current && alive(current.pid)) {
        try { process.kill(-current.pid, 'SIGTERM'); } catch {}
    }
    rmSync(statePath, { force: true });
    process.exit(0);
}
if (args[0] === 'save' || args[0] === 'startup') process.exit(0);
process.exit(0);
`);
    chmodSync(fakePm2, 0o755);

    process.env.HOME = home;
    process.env.SUPERTASK_CONFIG_PATH = configPath;
    process.env.SUPERTASK_DB_PATH = dbPath;
    process.env.SUPERTASK_OPENCODE_BIN = fakeOpencode;
    process.env.SUPERTASK_PM2_BIN = fakePm2;
    process.env.SUPERTASK_BUN_BIN = process.execPath;
    process.env.SUPERTASK_GATEWAY_ENTRY = join(process.cwd(), 'dist/gateway/index.js');
    process.env.SUPERTASK_VERSION_FILE = join(dir, 'gateway-version');
    process.env.SUPERTASK_GATEWAY_READY_TIMEOUT_MS = '10000';
    process.env.SUPERTASK_PM2_KILL_TIMEOUT_MS = '6000';
}, 30_000);

afterAll(async () => {
    if (fakePm2) spawnSync(fakePm2, ['delete', 'supertask-gateway'], { stdio: 'ignore' });
    await Bun.sleep(200);
    process.env = originalEnv;
    if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('构建产物端到端', () => {
    test('独立 Gateway 在没有 OpenCode 交互进程时执行 delayed 任务', async () => {
        try {
            expect(ensureGateway()).toEqual({ ok: true, action: 'started' });
        } catch (error) {
            const logs = existsSync(gatewayLog) ? readFileSync(gatewayLog, 'utf8') : '无 Gateway 日志';
            const state = existsSync(statePath) ? readFileSync(statePath, 'utf8') : '无 PM2 状态';
            let lock = '无 Gateway 锁';
            if (existsSync(dbPath)) {
                const database = new Database(dbPath, { readonly: true });
                lock = JSON.stringify(database.query(
                    'SELECT pid, heartbeat_at, ready_at FROM gateway_lock WHERE id = 1',
                ).get());
                database.close();
            }
            throw new Error(`${error instanceof Error ? error.message : String(error)}\nstate=${state}\nlock=${lock}\n${logs}`);
        }

        const health = await fetch(`http://127.0.0.1:${dashboardPort}/health`);
        expect(health.status).toBe(200);

        const cli = join(process.cwd(), 'dist/cli/index.js');
        const output = execFileSync(process.execPath, [
            cli,
            'template', 'add',
            '--name', '构建产物定时任务',
            '--agent', 'test-agent',
            '--prompt', '验证 Gateway 独立调度',
            '--type', 'delayed',
            '--delay', '200ms',
            '--max-retries', '0',
        ], {
            cwd: dir,
            env: process.env,
            encoding: 'utf8',
        });
        expect(JSON.parse(output).status).toBe('created');

        const db = new Database(process.env.SUPERTASK_DB_PATH!, { readonly: true });
        const deadline = Date.now() + 10_000;
        let task: { status: string; result_log: string | null } | null = null;
        while (Date.now() < deadline) {
            task = db.query(
                'SELECT status, result_log FROM tasks WHERE name = ? ORDER BY id DESC LIMIT 1',
            ).get('构建产物定时任务') as typeof task;
            if (task?.status === 'done') break;
            await Bun.sleep(50);
        }
        const template = db.query(
            'SELECT enabled FROM task_templates WHERE name = ? ORDER BY id DESC LIMIT 1',
        ).get('构建产物定时任务') as { enabled: number } | null;
        db.close();

        expect(task?.status).toBe('done');
        expect(task?.result_log).toContain('定时任务执行完成');
        expect(template?.enabled).toBe(0);
        expect(existsSync(join(dir, 'opencode-called'))).toBe(true);
        const args = JSON.parse(readFileSync(join(dir, 'opencode-called'), 'utf8')) as string[];
        expect(args.slice(0, 5)).toEqual(['run', '--agent', 'test-agent', '--format', 'json']);
    }, 30_000);
});
