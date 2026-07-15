import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { execFileSync, spawnSync } from 'child_process';
import {
    chmodSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let tempDir: string;
let testDbPath: string;
let fakePm2Path: string;
let pm2StatePath: string;
let pm2LogPath: string;
let pm2StartFailurePath: string;

function cliEnv(): NodeJS.ProcessEnv {
    return {
        ...process.env,
        SUPERTASK_DB_PATH: testDbPath,
        SUPERTASK_PM2_BIN: fakePm2Path,
        SUPERTASK_GATEWAY_READY_TIMEOUT_MS: '300',
    };
}

function runJson<T>(args: string[]): T {
    const output = execFileSync('bun', ['run', 'src/cli/index.ts', ...args], {
        cwd: process.cwd(),
        encoding: 'utf-8',
        timeout: 15_000,
        env: cliEnv(),
    });
    return JSON.parse(output) as T;
}

function runFailure(args: string[]): string {
    const result = spawnSync('bun', ['run', 'src/cli/index.ts', ...args], {
        cwd: process.cwd(),
        encoding: 'utf-8',
        timeout: 15_000,
        env: cliEnv(),
    });
    expect(result.status).not.toBe(0);
    return `${result.stdout}${result.stderr}`;
}

function writeGatewayLock(): void {
    const sqlite = new Database(testDbPath);
    const now = Date.now();
    sqlite.query(
        'INSERT OR REPLACE INTO gateway_lock (id, pid, acquired_at, heartbeat_at, ready_at) VALUES (1, ?, ?, ?, ?)',
    ).run(process.pid, now, now, now);
    sqlite.close();
}

function setPm2Online(): void {
    writeFileSync(pm2StatePath, 'online');
    writeGatewayLock();
}

function pm2Calls(): string[][] {
    const contents = readFileSync(pm2LogPath, 'utf8').trim();
    return contents === ''
        ? []
        : contents.split('\n').map((line) => JSON.parse(line) as string[]);
}

beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'supertask-db-pm2-'));
    testDbPath = join(tempDir, 'tasks.db');
    fakePm2Path = join(tempDir, 'pm2');
    pm2StatePath = join(tempDir, 'pm2-state');
    pm2LogPath = join(tempDir, 'pm2-calls.jsonl');
    pm2StartFailurePath = join(tempDir, 'pm2-start-failure');
    writeFileSync(pm2LogPath, '');
    writeFileSync(fakePm2Path, `#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { Database } from 'bun:sqlite';
const args = process.argv.slice(2);
if (args[0] === '--version') {
    console.log('6.0.0');
    process.exit(0);
}
if (args[0] === 'jlist') {
    const status = readFileSync(${JSON.stringify(pm2StatePath)}, 'utf8').trim();
    console.log(JSON.stringify([{ name: 'supertask-gateway', pid: ${process.pid}, pm2_env: { status } }]));
    process.exit(0);
}
appendFileSync(${JSON.stringify(pm2LogPath)}, JSON.stringify(args) + '\\n');
if (args[0] === 'start' && existsSync(${JSON.stringify(pm2StartFailurePath)})) {
    console.error('模拟 PM2 启动失败');
    process.exit(1);
}
if (args[0] === 'stop') {
    writeFileSync(${JSON.stringify(pm2StatePath)}, 'stopped');
    const db = new Database(${JSON.stringify(testDbPath)});
    db.exec('DELETE FROM gateway_lock');
    db.close();
}
if (args[0] === 'start') {
    writeFileSync(${JSON.stringify(pm2StatePath)}, 'online');
    const db = new Database(${JSON.stringify(testDbPath)});
    const now = Date.now();
    db.query('INSERT OR REPLACE INTO gateway_lock (id, pid, acquired_at, heartbeat_at, ready_at) VALUES (1, ?, ?, ?, ?)').run(${process.pid}, now, now, now);
    db.close();
}
`);
    chmodSync(fakePm2Path, 0o755);
    writeFileSync(pm2StatePath, 'stopped');
});

afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
});

describe('数据库维护 CLI 的 PM2 生命周期编排', () => {
    test('默认自动停启、可保持停止，并在维护失败后恢复 Gateway', () => {
        runJson<{ ok: boolean }>(['db', 'check']);
        runJson<{ id: number }>([
            'add', '--name', '自动停启验证任务', '--agent', 'test-agent', '--prompt', '验证清空流程',
        ]);
        writeFileSync(pm2StatePath, 'online');
        const unrelated = runJson<{
            gateway: { wasRunning: boolean; restarted: boolean; keptStopped: boolean };
        }>(['db', 'clear', '--confirm', 'CLEAR']);
        expect(unrelated.gateway).toEqual({ wasRunning: false, restarted: false, keptStopped: false });
        expect(pm2Calls()).toEqual([]);

        runJson<{ id: number }>([
            'add', '--name', '受管 Gateway 验证任务', '--agent', 'test-agent', '--prompt', '验证清空流程',
        ]);
        setPm2Online();

        const cleared = runJson<{
            backupPath: string;
            gateway: { wasRunning: boolean; restarted: boolean; keptStopped: boolean };
        }>(['db', 'clear', '--confirm', 'CLEAR']);
        expect(cleared.gateway).toEqual({ wasRunning: true, restarted: true, keptStopped: false });
        expect(readFileSync(pm2StatePath, 'utf8')).toBe('online');
        expect(pm2Calls()).toEqual([
            ['stop', 'supertask-gateway'],
            ['start', 'supertask-gateway'],
        ]);

        runJson<{ id: number }>([
            'add', '--name', '保持停止验证任务', '--agent', 'test-agent', '--prompt', '验证 keep-stopped',
        ]);
        const keptStopped = runJson<{
            gateway: { wasRunning: boolean; restarted: boolean; keptStopped: boolean };
        }>(['db', 'clear', '--confirm', 'CLEAR', '--keep-stopped']);
        expect(keptStopped.gateway).toEqual({ wasRunning: true, restarted: false, keptStopped: true });
        expect(readFileSync(pm2StatePath, 'utf8')).toBe('stopped');

        setPm2Online();
        const restored = runJson<{
            gateway: { wasRunning: boolean; restarted: boolean; keptStopped: boolean };
        }>(['db', 'restore', '--from', cleared.backupPath, '--confirm', 'RESTORE']);
        expect(restored.gateway).toEqual({ wasRunning: true, restarted: true, keptStopped: false });

        const runningTask = runJson<{ id: number }>([
            'add', '--name', '失败恢复验证任务', '--agent', 'test-agent', '--prompt', '验证失败恢复',
        ]);
        runJson<{ status: string }>(['start', '--id', String(runningTask.id)]);
        setPm2Online();
        expect(runFailure(['db', 'clear', '--confirm', 'CLEAR'])).toContain('运行中');
        expect(readFileSync(pm2StatePath, 'utf8')).toBe('online');

        const calls = pm2Calls();
        expect(calls.filter((call) => call[0] === 'stop')).toHaveLength(4);
        expect(calls.filter((call) => call[0] === 'start')).toHaveLength(3);

        runJson<{ status: string }>(['done', '--id', String(runningTask.id)]);
        runJson<{ id: number }>([
            'add', '--name', '重启失败验证任务', '--agent', 'test-agent', '--prompt', '验证维护结果提示',
        ]);
        setPm2Online();
        writeFileSync(pm2StartFailurePath, 'fail');
        expect(runFailure(['db', 'clear', '--confirm', 'CLEAR'])).toContain('数据库维护已完成');
        expect(readFileSync(pm2StatePath, 'utf8')).toBe('stopped');
        expect(runJson<{ counts: { tasks: number } }>(['db', 'check']).counts.tasks).toBe(0);
    });
});
