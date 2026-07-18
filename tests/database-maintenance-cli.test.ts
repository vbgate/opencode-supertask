import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { execFileSync, spawn, spawnSync } from 'child_process';
import {
    copyFileSync,
    existsSync,
    linkSync,
    mkdtempSync,
    rmSync,
    statSync,
    symlinkSync,
    watch,
    writeFileSync,
} from 'fs';
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
}, 30_000);

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

        const hardlinkPath = join(tempDir, 'current-hardlink.db');
        linkSync(testDbPath, hardlinkPath);
        expect(runFailure([
            'db', 'restore', '--from', hardlinkPath, '--confirm', 'RESTORE',
        ])).toContain('当前数据库');
        const symlinkPath = join(tempDir, 'current-symlink.db');
        try {
            symlinkSync(testDbPath, symlinkPath);
            expect(runFailure([
                'db', 'restore', '--from', symlinkPath, '--confirm', 'RESTORE',
            ])).toContain('当前数据库');
        } catch (error) {
            const code = error instanceof Error && 'code' in error ? error.code : undefined;
            if (code !== 'EPERM' && code !== 'EACCES' && code !== 'ENOTSUP') throw error;
        }

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

        const expandedDb = new Database(testDbPath);
        let migrationsBeforeClear: number;
        try {
            expandedDb.exec(`
                CREATE TABLE future_business_state (
                    id INTEGER PRIMARY KEY,
                    peer_id INTEGER REFERENCES future_business_peer(id),
                    value TEXT
                );
                CREATE TABLE future_business_peer (
                    id INTEGER PRIMARY KEY,
                    state_id INTEGER REFERENCES future_business_state(id),
                    value TEXT
                );
                BEGIN;
                PRAGMA defer_foreign_keys = ON;
                INSERT INTO future_business_state VALUES (1, 1, 'must-be-cleared');
                INSERT INTO future_business_peer VALUES (1, 1, 'must-be-cleared');
                COMMIT;
            `);
            migrationsBeforeClear = (expandedDb.query(
                'SELECT COUNT(*) AS count FROM __drizzle_migrations',
            ).get() as { count: number }).count;
        } finally {
            expandedDb.close();
        }

        const cleared = runJson<{
            backupPath: string;
            deleted: { tasks: number; taskRuns: number; taskTemplates: number };
            check: { ok: boolean; counts: { tasks: number; taskRuns: number; taskTemplates: number } };
        }>(['db', 'clear', '--confirm', 'CLEAR']);
        expect(cleared.deleted.tasks).toBeGreaterThan(0);
        expect(cleared.deleted.taskTemplates).toBe(1);
        expect(cleared.check.ok).toBe(true);
        expect(cleared.check.counts).toEqual({ tasks: 0, taskRuns: 0, taskTemplates: 0 });
        const clearedDb = new Database(testDbPath, { readonly: true, strict: true });
        try {
            expect((clearedDb.query('SELECT COUNT(*) AS count FROM future_business_state')
                .get() as { count: number }).count).toBe(0);
            expect((clearedDb.query('SELECT COUNT(*) AS count FROM future_business_peer')
                .get() as { count: number }).count).toBe(0);
            expect((clearedDb.query('SELECT COUNT(*) AS count FROM __drizzle_migrations')
                .get() as { count: number }).count).toBe(migrationsBeforeClear);
        } finally {
            clearedDb.close();
        }

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
        const restoredExpandedDb = new Database(testDbPath, { readonly: true, strict: true });
        try {
            expect((restoredExpandedDb.query('SELECT value FROM future_business_state')
                .get() as { value: string }).value).toBe('must-be-cleared');
            expect((restoredExpandedDb.query('SELECT value FROM future_business_peer')
                .get() as { value: string }).value).toBe('must-be-cleared');
        } finally {
            restoredExpandedDb.close();
        }

        const walSourcePath = join(tempDir, 'wal-source.db');
        runJson<{ path: string }>(['db', 'backup', '--output', walSourcePath]);
        const walSource = new Database(walSourcePath);
        try {
            walSource.exec('PRAGMA journal_mode = WAL;');
            walSource.exec('PRAGMA wal_checkpoint(TRUNCATE);');
            const walOnlyTask = walSource.query(`
                INSERT INTO tasks (name, agent, prompt, status, created_at)
                VALUES ('WAL-only restore row', 'test-agent', '必须从 WAL 快照恢复', 'pending', ?)
                RETURNING id
            `).get(Math.floor(Date.now() / 1000)) as { id: number };
            const walPath = `${walSourcePath}-wal`;
            expect(existsSync(walPath)).toBe(true);
            expect(statSync(walPath).size).toBeGreaterThan(0);

            const mainOnlyPath = join(tempDir, 'wal-main-only.db');
            copyFileSync(walSourcePath, mainOnlyPath);
            const mainOnly = new Database(mainOnlyPath, { readwrite: true, create: false, strict: true });
            try {
                const absent = mainOnly.query(
                    "SELECT COUNT(*) AS count FROM tasks WHERE name = 'WAL-only restore row'",
                ).get() as { count: number };
                expect(absent.count).toBe(0);
            } finally {
                mainOnly.close();
            }

            const walRestored = runJson<{
                check: { ok: boolean; counts: { tasks: number } };
            }>(['db', 'restore', '--from', walSourcePath, '--confirm', 'RESTORE']);
            expect(walRestored.check.ok).toBe(true);
            const restoredDatabase = new Database(testDbPath, { readonly: true, strict: true });
            try {
                const restoredWalTask = restoredDatabase.query(
                    'SELECT name FROM tasks WHERE id = ?',
                ).get(walOnlyTask.id) as { name: string } | null;
                expect(restoredWalTask?.name).toBe('WAL-only restore row');
            } finally {
                restoredDatabase.close();
            }
        } finally {
            walSource.close();
        }

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
    }, 30_000);

    test('恢复排他事务期间返回成功的并发写入在提交后保留', async () => {
        const sourcePath = join(tempDir, 'large-concurrency-source.db');
        runJson<{ path: string }>(['db', 'backup', '--output', sourcePath]);
        const source = new Database(sourcePath);
        try {
            source.query(
                'UPDATE tasks SET prompt = ? WHERE id = (SELECT MIN(id) FROM tasks)',
            ).run('x'.repeat(64 * 1024 * 1024));
        } finally {
            source.close();
        }

        let stageCreatedResolve: (() => void) | undefined;
        const stageCreated = new Promise<void>((resolve) => {
            stageCreatedResolve = resolve;
        });
        const stageWatcher = watch(tempDir, (_event, filename) => {
            if (filename?.toString().startsWith('tasks.db.restore-')) stageCreatedResolve?.();
        });
        const restore = spawn(
            'bun',
            ['run', 'src/cli/index.ts', 'db', 'restore', '--from', sourcePath, '--confirm', 'RESTORE'],
            {
                cwd: process.cwd(),
                env: { ...process.env, SUPERTASK_DB_PATH: testDbPath },
                stdio: ['ignore', 'pipe', 'pipe'],
            },
        );
        let restoreStdout = '';
        let restoreStderr = '';
        restore.stdout.setEncoding('utf8');
        restore.stderr.setEncoding('utf8');
        restore.stdout.on('data', (chunk: string) => { restoreStdout += chunk; });
        restore.stderr.on('data', (chunk: string) => { restoreStderr += chunk; });
        const restoreCompleted = new Promise<number | null>((resolve) => {
            restore.once('close', (code) => resolve(code));
        });

        let restoreStopped = false;
        try {
            const stageObserved = await Promise.race([
                stageCreated.then(() => true),
                restoreCompleted.then(() => false),
                Bun.sleep(5_000).then(() => false),
            ]);
            expect(stageObserved).toBe(true);
            if (restore.pid == null) throw new Error('restore 子进程没有 PID');
            process.kill(restore.pid, 'SIGSTOP');
            restoreStopped = true;

            let exclusiveObserved = false;
            const probe = new Database(testDbPath);
            try {
                probe.exec('PRAGMA busy_timeout = 0;');
                probe.exec('BEGIN IMMEDIATE');
                probe.exec('ROLLBACK');
            } catch (error) {
                if (probe.inTransaction) probe.exec('ROLLBACK');
                const message = error instanceof Error ? error.message : String(error);
                if (message.includes('locked') || message.includes('busy')) exclusiveObserved = true;
                else throw error;
            } finally {
                probe.close();
            }
            expect(exclusiveObserved).toBe(true);

            const concurrentProcess = spawn(
                'bun',
                [
                    'run', 'src/cli/index.ts', 'add', '--name', '恢复锁后的并发写入',
                    '--agent', 'test-agent', '--prompt', '必须保留',
                ],
                {
                    cwd: process.cwd(),
                    env: { ...process.env, SUPERTASK_DB_PATH: testDbPath },
                    stdio: ['ignore', 'pipe', 'pipe'],
                },
            );
            let concurrentStdout = '';
            let concurrentStderr = '';
            concurrentProcess.stdout.setEncoding('utf8');
            concurrentProcess.stderr.setEncoding('utf8');
            concurrentProcess.stdout.on('data', (chunk: string) => { concurrentStdout += chunk; });
            concurrentProcess.stderr.on('data', (chunk: string) => { concurrentStderr += chunk; });
            const concurrentCompleted = new Promise<number | null>((resolve) => {
                concurrentProcess.once('close', (code) => resolve(code));
            });
            await Bun.sleep(100);
            expect(concurrentProcess.exitCode).toBeNull();

            process.kill(restore.pid, 'SIGCONT');
            restoreStopped = false;
            expect(await restoreCompleted).toBe(0);
            expect(restoreStderr).toBe('');
            expect(() => JSON.parse(restoreStdout)).not.toThrow();
            expect(await concurrentCompleted).toBe(0);
            expect(concurrentStderr).toBe('');
            const concurrent = JSON.parse(concurrentStdout) as { id: number };

            const verified = new Database(testDbPath, { readonly: true, strict: true });
            try {
                const row = verified.query(
                    'SELECT name FROM tasks WHERE id = ?',
                ).get(concurrent.id) as { name: string } | null;
                expect(row?.name).toBe('恢复锁后的并发写入');
            } finally {
                verified.close();
            }
        } finally {
            stageWatcher.close();
            if (restoreStopped && restore.pid != null) process.kill(restore.pid, 'SIGCONT');
        }
    }, 20_000);

    test('恢复对未来 expand-only 表列完整复制或在不兼容时失败关闭', () => {
        const live = new Database(testDbPath);
        let preservedTaskId: number;
        try {
            live.exec(`
                ALTER TABLE tasks ADD COLUMN future_note TEXT;
                CREATE TABLE future_shared (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    value TEXT
                );
                INSERT INTO future_shared(value) VALUES ('live-value');
            `);
            const task = live.query('SELECT MIN(id) AS id FROM tasks').get() as { id: number };
            preservedTaskId = task.id;
            live.query('UPDATE tasks SET future_note = ? WHERE id = ?')
                .run('live-value', preservedTaskId);
        } finally {
            live.close();
        }

        const sharedFuturePath = join(tempDir, 'shared-future-column.db');
        runJson<{ path: string }>(['db', 'backup', '--output', sharedFuturePath]);
        const sharedFuture = new Database(sharedFuturePath);
        try {
            sharedFuture.query('UPDATE tasks SET future_note = ? WHERE id = ?')
                .run('must-survive', preservedTaskId);
            sharedFuture.exec("UPDATE future_shared SET value = 'must-survive'");
        } finally {
            sharedFuture.close();
        }
        runJson<{ check: { ok: boolean } }>([
            'db', 'restore', '--from', sharedFuturePath, '--confirm', 'RESTORE',
        ]);
        const preserved = new Database(testDbPath, { readonly: true, strict: true });
        try {
            const row = preserved.query('SELECT future_note FROM tasks WHERE id = ?')
                .get(preservedTaskId) as { future_note: string | null };
            expect(row.future_note).toBe('must-survive');
            const futureRow = preserved.query('SELECT value FROM future_shared')
                .get() as { value: string };
            expect(futureRow.value).toBe('must-survive');
        } finally {
            preserved.close();
        }

        const unknownColumnPath = join(tempDir, 'unknown-source-column.db');
        runJson<{ path: string }>(['db', 'backup', '--output', unknownColumnPath]);
        const unknownColumn = new Database(unknownColumnPath);
        try {
            unknownColumn.exec('ALTER TABLE tasks ADD COLUMN source_only_note TEXT');
            unknownColumn.query('UPDATE tasks SET source_only_note = ? WHERE id = ?')
                .run('must-not-be-dropped', preservedTaskId);
        } finally {
            unknownColumn.close();
        }
        const columnSentinel = runJson<{ id: number }>([
            'add', '--name', '未知列失败前哨', '--agent', 'test-agent', '--prompt', '必须保留',
        ]);
        expect(runFailure([
            'db', 'restore', '--from', unknownColumnPath, '--confirm', 'RESTORE',
        ])).toContain('不认识的可写列');
        const afterColumnFailure = new Database(testDbPath, { readonly: true, strict: true });
        try {
            expect(afterColumnFailure.query('SELECT name FROM tasks WHERE id = ?')
                .get(columnSentinel.id)).not.toBeNull();
        } finally {
            afterColumnFailure.close();
        }

        const unknownTablePath = join(tempDir, 'unknown-source-table.db');
        runJson<{ path: string }>(['db', 'backup', '--output', unknownTablePath]);
        const unknownTable = new Database(unknownTablePath);
        try {
            unknownTable.exec(`
                CREATE TABLE future_source_only (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    value TEXT
                );
                INSERT INTO future_source_only(value) VALUES ('must-not-be-ignored');
            `);
        } finally {
            unknownTable.close();
        }
        const tableSentinel = runJson<{ id: number }>([
            'add', '--name', '未知表失败前哨', '--agent', 'test-agent', '--prompt', '必须保留',
        ]);
        expect(runFailure([
            'db', 'restore', '--from', unknownTablePath, '--confirm', 'RESTORE',
        ])).toContain('不认识的业务表');
        const afterTableFailure = new Database(testDbPath, { readonly: true, strict: true });
        try {
            expect(afterTableFailure.query('SELECT name FROM tasks WHERE id = ?')
                .get(tableSentinel.id)).not.toBeNull();
        } finally {
            afterTableFailure.close();
        }

        const olderSchemaPath = join(tempDir, 'older-schema-source.db');
        runJson<{ path: string }>(['db', 'backup', '--output', olderSchemaPath]);
        const expandedLive = new Database(testDbPath);
        try {
            expandedLive.exec(`
                ALTER TABLE tasks ADD COLUMN live_nullable_note TEXT;
                ALTER TABLE tasks ADD COLUMN live_default_note TEXT NOT NULL DEFAULT 'safe-default';
                CREATE TABLE future_live_only (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    value TEXT
                );
                INSERT INTO future_live_only(value) VALUES ('newer-timepoint-data');
            `);
            expandedLive.query('UPDATE tasks SET live_nullable_note = ? WHERE id = ?')
                .run('newer-value', preservedTaskId);
        } finally {
            expandedLive.close();
        }
        runJson<{ check: { ok: boolean } }>([
            'db', 'restore', '--from', olderSchemaPath, '--confirm', 'RESTORE',
        ]);
        const olderRestored = new Database(testDbPath, { readonly: true, strict: true });
        try {
            const futureCount = olderRestored.query(
                'SELECT COUNT(*) AS count FROM future_live_only',
            ).get() as { count: number };
            const task = olderRestored.query(
                'SELECT live_nullable_note, live_default_note FROM tasks WHERE id = ?',
            ).get(preservedTaskId) as {
                live_nullable_note: string | null;
                live_default_note: string;
            };
            expect(futureCount.count).toBe(0);
            expect(task.live_nullable_note).toBeNull();
            expect(task.live_default_note).toBe('safe-default');
        } finally {
            olderRestored.close();
        }
    }, 20_000);
});
