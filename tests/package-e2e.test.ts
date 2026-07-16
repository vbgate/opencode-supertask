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
let invocationLog = '';
let retryMarker = '';

beforeAll(() => {
    execFileSync(process.execPath, ['run', 'build'], { cwd: process.cwd(), stdio: 'pipe' });

    dir = mkdtempSync(join(tmpdir(), 'supertask-package-e2e-'));
    const home = join(dir, 'home');
    const configDir = join(home, '.config/opencode');
    dbPath = join(dir, 'tasks.db');
    statePath = join(dir, 'pm2-state.json');
    gatewayLog = join(dir, 'gateway.log');
    invocationLog = join(dir, 'opencode-calls.jsonl');
    retryMarker = join(dir, 'retry-attempted');
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

    writeFileSync(invocationLog, '');
    writeFileSync(fakeOpencode, `#!/usr/bin/env bun
import { appendFileSync, existsSync, writeFileSync } from 'fs';
const args = Bun.argv.slice(2);
appendFileSync(${JSON.stringify(invocationLog)}, JSON.stringify(args) + '\\n');
const prompt = args.at(-1) ?? '';
if (prompt.includes('失败后自动重试') && !existsSync(${JSON.stringify(retryMarker)})) {
    writeFileSync(${JSON.stringify(retryMarker)}, 'failed-once');
    console.error('模拟首次执行失败');
    process.exit(7);
}
console.log(JSON.stringify({ sessionID: 'ses_package_e2e', message: '隔离任务执行完成' }));
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
        ? JSON.stringify([{ name: 'supertask-gateway', pid: current.pid, pm2_env: {
            status: 'online', args: [current.entry], pm_exec_path: current.bunPath,
            pm_cwd: current.cwd, env: process.env
        } }])
        : '[]');
    process.exit(0);
}
if (args[0] === 'start') {
    const separator = args.indexOf('--');
    const cwd = args[args.indexOf('--cwd') + 1];
    const out = openSync(logPath, 'a');
    writeFileSync(logPath, JSON.stringify({
        launcherPid: process.pid,
        configPath: process.env.SUPERTASK_CONFIG_PATH,
        dbPath: process.env.SUPERTASK_DB_PATH,
    }) + '\\n', { flag: 'a' });
    const child = spawn(args[1], args.slice(separator + 1), {
        detached: true,
        cwd,
        env: process.env,
        stdio: ['ignore', out, out],
    });
    child.unref();
    writeFileSync(statePath, JSON.stringify({ pid: child.pid, entry: args.at(-1), bunPath: args[1], cwd }));
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
    process.env.SUPERTASK_PM2_KILL_TIMEOUT_MS = '16000';
}, 30_000);

afterAll(async () => {
    if (fakePm2) spawnSync(fakePm2, ['delete', 'supertask-gateway'], { stdio: 'ignore' });
    await Bun.sleep(200);
    process.env = originalEnv;
    if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('构建产物端到端', () => {
    test('独立 Gateway 执行普通任务、重试及三种调度模板', async () => {
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
        const runCli = <T>(args: string[]): T => JSON.parse(execFileSync(process.execPath, [
            cli, ...args,
        ], {
            cwd: dir,
            env: process.env,
            encoding: 'utf8',
        })) as T;
        const db = new Database(process.env.SUPERTASK_DB_PATH!, { readonly: true });
        const waitFor = async <T>(read: () => T | null, done: (value: T) => boolean): Promise<T | null> => {
            const deadline = Date.now() + 10_000;
            let value: T | null = null;
            while (Date.now() < deadline) {
                value = read();
                if (value !== null && done(value)) return value;
                await Bun.sleep(50);
            }
            return value;
        };
        const taskByName = (name: string) => db.query(
            'SELECT id, status, result_log, retry_count, template_id FROM tasks WHERE name = ? ORDER BY id DESC LIMIT 1',
        ).get(name) as {
            id: number;
            status: string;
            result_log: string | null;
            retry_count: number;
            template_id: number | null;
        } | null;

        runCli<{ id: number }>([
            'add',
            '--name', '构建产物普通任务',
            '--agent', 'test-agent',
            '--prompt', '验证普通队列执行',
            '--max-retries', '0',
        ]);
        const normalTask = await waitFor(
            () => taskByName('构建产物普通任务'),
            (task) => task.status === 'done',
        );
        expect(normalTask?.status).toBe('done');
        expect(normalTask?.result_log).toContain('隔离任务执行完成');

        runCli<{ id: number }>([
            'add',
            '--name', '构建产物重试任务',
            '--agent', 'test-agent',
            '--prompt', '验证失败后自动重试',
            '--max-retries', '1',
            '--retry-backoff', '100ms',
        ]);
        const retriedTask = await waitFor(
            () => taskByName('构建产物重试任务'),
            (task) => task.status === 'done',
        );
        expect(retriedTask?.status).toBe('done');
        expect(retriedTask?.retry_count).toBe(1);
        const retryRuns = db.query(
            'SELECT status FROM task_runs WHERE task_id = ? ORDER BY id',
        ).all(retriedTask!.id) as Array<{ status: string }>;
        expect(retryRuns.map((run) => run.status)).toEqual(['failed', 'done']);

        const delayedTemplate = runCli<{ id: number; status: string }>([
            'template', 'add',
            '--name', '构建产物定时任务',
            '--agent', 'test-agent',
            '--prompt', '验证 Gateway 独立调度',
            '--type', 'delayed',
            '--delay', '200ms',
            '--max-retries', '0',
        ]);
        expect(delayedTemplate.status).toBe('created');
        const delayedTask = await waitFor(
            () => taskByName('构建产物定时任务'),
            (task) => task.status === 'done',
        );
        const delayedRow = db.query(
            'SELECT enabled FROM task_templates WHERE name = ? ORDER BY id DESC LIMIT 1',
        ).get('构建产物定时任务') as { enabled: number } | null;
        expect(delayedTask?.status).toBe('done');
        expect(delayedTask?.template_id).toBe(delayedTemplate.id);
        expect(delayedRow?.enabled).toBe(0);

        const recurringTemplate = runCli<{ id: number }>([
            'template', 'add',
            '--name', '构建产物循环任务',
            '--agent', 'test-agent',
            '--prompt', '验证 recurring 调度',
            '--type', 'recurring',
            '--interval', '300ms',
            '--max-retries', '0',
        ]);
        const recurringCount = await waitFor(
            () => db.query(
                "SELECT COUNT(*) AS count FROM tasks WHERE template_id = ? AND status = 'done'",
            ).get(recurringTemplate.id) as { count: number },
            (row) => row.count >= 2,
        );
        expect(recurringCount?.count).toBeGreaterThanOrEqual(2);
        expect(runCli<{ enabled: boolean }>([
            'template', 'disable', '--id', String(recurringTemplate.id),
        ]).enabled).toBe(false);

        const cronTemplate = runCli<{ id: number }>([
            'template', 'add',
            '--name', '构建产物 Cron 任务',
            '--agent', 'test-agent',
            '--prompt', '验证 cron 调度',
            '--type', 'cron',
            '--cron', '*/1 * * * * *',
            '--max-retries', '0',
        ]);
        const cronCount = await waitFor(
            () => db.query(
                "SELECT COUNT(*) AS count FROM tasks WHERE template_id = ? AND status = 'done'",
            ).get(cronTemplate.id) as { count: number },
            (row) => row.count >= 1,
        );
        expect(cronCount?.count).toBeGreaterThanOrEqual(1);
        expect(runCli<{ enabled: boolean }>([
            'template', 'disable', '--id', String(cronTemplate.id),
        ]).enabled).toBe(false);

        const invocations = readFileSync(invocationLog, 'utf8').trim().split('\n')
            .map((line) => JSON.parse(line) as string[]);
        expect(invocations.length).toBeGreaterThanOrEqual(7);
        for (const args of invocations) {
            expect(args.slice(0, 5)).toEqual(['run', '--agent', 'test-agent', '--format', 'json']);
        }

        const finalHealth = await fetch(`http://127.0.0.1:${dashboardPort}/health`);
        expect(finalHealth.status).toBe(200);
        db.close();
    }, 30_000);
});
