import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let tempDir: string;
let testDbPath: string;

function runJson<T>(args: string[]): T {
    const output = execFileSync('bun', ['run', 'src/cli/index.ts', ...args], {
        cwd: process.cwd(),
        encoding: 'utf-8',
        timeout: 15_000,
        env: { ...process.env, SUPERTASK_DB_PATH: testDbPath },
    });
    return JSON.parse(output) as T;
}

function runFailure(args: string[]): string {
    const result = spawnSync('bun', ['run', 'src/cli/index.ts', ...args], {
        cwd: process.cwd(),
        encoding: 'utf-8',
        timeout: 15_000,
        env: { ...process.env, SUPERTASK_DB_PATH: testDbPath },
    });
    expect(result.status).not.toBe(0);
    return `${result.stdout}${result.stderr}`;
}

function setTaskStatus(taskId: number, status: 'running' | 'done'): void {
    const sqlite = new Database(testDbPath);
    const now = Math.floor(Date.now() / 1000);
    sqlite.query(
        'UPDATE tasks SET status = ?, started_at = ?, finished_at = ? WHERE id = ?',
    ).run(status, now, status === 'done' ? now : null, taskId);
    sqlite.close();
}

beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'supertask-db-maintenance-'));
    testDbPath = join(tempDir, 'tasks.db');
});

afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
});

describe('数据库维护 CLI', () => {
    test('check、backup、clear、restore 构成可回滚的完整流程', () => {
        const initial = runJson<{
            ok: boolean;
            path: string;
            counts: { tasks: number; taskRuns: number; taskTemplates: number };
        }>(['db', 'check']);
        expect(initial.ok).toBe(true);
        expect(initial.path).toBe(testDbPath);
        expect(initial.counts).toEqual({ tasks: 0, taskRuns: 0, taskTemplates: 0 });

        const task = runJson<{ id: number }>([
            'add', '--name', '数据库维护任务', '--agent', 'test-agent', '--prompt', '验证备份恢复',
        ]);
        runJson<{ id: number }>([
            'template', 'add', '--name', '数据库维护模板', '--agent', 'test-agent',
            '--prompt', '验证模板恢复', '--type', 'cron', '--cron', '0 9 * * *',
        ]);

        const explicitBackupPath = join(tempDir, 'explicit-backup.db');
        const backup = runJson<{ path: string; sizeBytes: number; check: { ok: boolean } }>([
            'db', 'backup', '--output', explicitBackupPath,
        ]);
        expect(backup.path).toBe(explicitBackupPath);
        expect(backup.sizeBytes).toBeGreaterThan(0);
        expect(backup.check.ok).toBe(true);

        expect(runFailure(['db', 'clear'])).toContain('--confirm CLEAR');

        const lockDb = new Database(testDbPath);
        const now = Date.now();
        lockDb.query(
            'INSERT OR REPLACE INTO gateway_lock (id, pid, acquired_at, heartbeat_at, ready_at) VALUES (1, ?, ?, ?, ?)',
        ).run(process.pid, now, now, now);
        lockDb.close();
        expect(runFailure(['db', 'clear', '--confirm', 'CLEAR'])).toContain('Gateway');

        const unlockDb = new Database(testDbPath);
        unlockDb.exec('DELETE FROM gateway_lock');
        unlockDb.close();

        setTaskStatus(task.id, 'running');
        expect(runFailure(['db', 'clear', '--confirm', 'CLEAR'])).toContain('运行中');
        setTaskStatus(task.id, 'done');

        const cleared = runJson<{
            backupPath: string;
            deleted: { tasks: number; taskRuns: number; taskTemplates: number };
            check: { ok: boolean; counts: { tasks: number; taskRuns: number; taskTemplates: number } };
        }>(['db', 'clear', '--confirm', 'CLEAR']);
        expect(cleared.deleted.tasks).toBeGreaterThan(0);
        expect(cleared.deleted.taskTemplates).toBe(1);
        expect(cleared.check.ok).toBe(true);
        expect(cleared.check.counts).toEqual({ tasks: 0, taskRuns: 0, taskTemplates: 0 });

        expect(runFailure(['db', 'restore', '--from', cleared.backupPath])).toContain('--confirm RESTORE');

        const restoreLockDb = new Database(testDbPath);
        const restoreLockNow = Date.now();
        restoreLockDb.query(
            'INSERT OR REPLACE INTO gateway_lock (id, pid, acquired_at, heartbeat_at, ready_at) VALUES (1, ?, ?, ?, ?)',
        ).run(process.pid, restoreLockNow, restoreLockNow, restoreLockNow);
        restoreLockDb.close();
        expect(runFailure([
            'db', 'restore', '--from', cleared.backupPath, '--confirm', 'RESTORE',
        ])).toContain('Gateway');

        const restoreUnlockDb = new Database(testDbPath);
        restoreUnlockDb.exec('DELETE FROM gateway_lock');
        restoreUnlockDb.close();

        const restored = runJson<{
            sourcePath: string;
            safetyBackupPath: string;
            check: { ok: boolean; counts: { tasks: number; taskRuns: number; taskTemplates: number } };
        }>(['db', 'restore', '--from', cleared.backupPath, '--confirm', 'RESTORE']);
        expect(restored.sourcePath).toBe(cleared.backupPath);
        expect(restored.safetyBackupPath).not.toBe(cleared.backupPath);
        expect(restored.check.ok).toBe(true);
        expect(restored.check.counts.tasks).toBeGreaterThan(0);
        expect(restored.check.counts.taskTemplates).toBe(1);

        const interruptedTask = runJson<{ id: number }>([
            'add', '--name', '恢复中断任务', '--agent', 'test-agent', '--prompt', '验证运行态收敛',
        ]);
        setTaskStatus(interruptedTask.id, 'running');
        const runningDb = new Database(testDbPath);
        runningDb.query(
            "INSERT INTO task_runs (task_id, status, started_at) VALUES (?, 'running', ?)",
        ).run(interruptedTask.id, Math.floor(Date.now() / 1000));
        runningDb.close();

        const runningBackupPath = join(tempDir, 'running-backup.db');
        runJson<{ path: string }>(['db', 'backup', '--output', runningBackupPath]);
        setTaskStatus(interruptedTask.id, 'done');
        const closedDb = new Database(testDbPath);
        closedDb.exec("UPDATE task_runs SET status = 'failed' WHERE status = 'running'");
        closedDb.close();

        const normalized = runJson<{
            recoveredRunningTasks: number;
            closedRunningRuns: number;
            check: { runningTasks: number; runningRuns: number };
        }>(['db', 'restore', '--from', runningBackupPath, '--confirm', 'RESTORE']);
        expect(normalized.recoveredRunningTasks).toBe(1);
        expect(normalized.closedRunningRuns).toBe(1);
        expect(normalized.check.runningTasks).toBe(0);
        expect(normalized.check.runningRuns).toBe(0);
        const normalizedTask = runJson<{ status: string }>(['get', '--id', String(interruptedTask.id)]);
        expect(normalizedTask.status).toBe('pending');

        const corruptPath = join(tempDir, 'corrupt.db');
        writeFileSync(corruptPath, '不是 SQLite 数据库');
        expect(runFailure([
            'db', 'restore', '--from', corruptPath, '--confirm', 'RESTORE',
        ])).toContain('备份文件');

        const afterFailure = runJson<{ ok: boolean; counts: { tasks: number } }>(['db', 'check']);
        expect(afterFailure.ok).toBe(true);
        expect(afterFailure.counts.tasks).toBeGreaterThan(0);
    });
});
