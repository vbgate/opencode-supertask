import { Database } from 'bun:sqlite';
import { randomUUID } from 'crypto';
import {
    chmodSync,
    constants,
    copyFileSync,
    existsSync,
    mkdirSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, resolve } from 'path';
import { closeDb, DB_FILE_PATH, getSqlite } from '@core/db';
import { isProcessAlive } from '@core/process-control';

const REQUIRED_TABLES = ['gateway_lock', 'tasks', 'task_runs', 'task_templates'] as const;

interface CountRow {
    count: number;
}

interface GatewayLockRow {
    pid: number;
}

export interface DatabaseCounts {
    tasks: number;
    taskRuns: number;
    taskTemplates: number;
}

export interface DatabaseCheckResult {
    ok: boolean;
    path: string;
    sizeBytes: number;
    journalMode: string;
    integrityMessages: string[];
    foreignKeyViolations: number;
    missingTables: string[];
    counts: DatabaseCounts;
    runningTasks: number;
    runningRuns: number;
}

export interface DatabaseBackupResult {
    path: string;
    sizeBytes: number;
    check: DatabaseCheckResult;
}

export interface DatabaseClearResult {
    backupPath: string;
    deleted: DatabaseCounts;
    check: DatabaseCheckResult;
}

export interface DatabaseRestoreResult {
    sourcePath: string;
    safetyBackupPath: string;
    recoveredRunningTasks: number;
    closedRunningRuns: number;
    check: DatabaseCheckResult;
}

export class DatabaseMaintenanceConflictError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DatabaseMaintenanceConflictError';
    }
}

function timestamp(): string {
    return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function normalizedPath(path: string): string {
    return path === ':memory:' ? path : resolve(path);
}

function safeUnlink(path: string): void {
    try {
        unlinkSync(path);
    } catch (error) {
        const code = error instanceof Error && 'code' in error ? error.code : undefined;
        if (code !== 'ENOENT') throw error;
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export class DatabaseMaintenanceService {
    static check(): DatabaseCheckResult {
        return this.inspect(getSqlite(), DB_FILE_PATH);
    }

    static backup(outputPath?: string): DatabaseBackupResult {
        const sqlite = getSqlite();
        try {
            sqlite.query('PRAGMA wal_checkpoint(PASSIVE)').get();
        } catch {
            // serialize() 本身提供一致快照；只读或内存数据库可能不支持 checkpoint。
        }
        return this.writeSnapshot(sqlite, outputPath ?? this.createBackupPath('backup'));
    }

    static clear(options: { allowCurrentGateway?: boolean } = {}): DatabaseClearResult {
        const sqlite = getSqlite();
        this.assertGatewaySafe(sqlite, options.allowCurrentGateway ?? false);
        this.assertNoRunningWork(sqlite);

        sqlite.exec('BEGIN IMMEDIATE');
        let backup: DatabaseBackupResult | null = null;
        try {
            this.assertGatewaySafe(sqlite, options.allowCurrentGateway ?? false);
            this.assertNoRunningWork(sqlite);

            const before = this.readCounts(sqlite);
            backup = this.writeSnapshot(sqlite, this.createBackupPath('pre-clear'));

            sqlite.exec('DELETE FROM task_runs');
            sqlite.exec('DELETE FROM tasks');
            sqlite.exec('DELETE FROM task_templates');
            sqlite.exec('COMMIT');

            return {
                backupPath: backup.path,
                deleted: before,
                check: this.inspect(sqlite, DB_FILE_PATH),
            };
        } catch (error) {
            if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
            if (error instanceof DatabaseMaintenanceConflictError) throw error;
            const backupHint = backup ? `；事务已回滚，备份保留在 ${backup.path}` : '';
            throw new Error(`清空数据库失败${backupHint}：${errorMessage(error)}`);
        }
    }

    static restore(sourcePath: string): DatabaseRestoreResult {
        if (DB_FILE_PATH === ':memory:') {
            throw new Error('内存数据库不支持 restore');
        }

        const source = normalizedPath(sourcePath);
        const livePath = normalizedPath(DB_FILE_PATH);
        if (source === livePath) throw new Error('恢复来源不能是当前数据库文件');

        const current = getSqlite();
        this.assertGatewaySafe(current, false);
        this.assertNoRunningWork(current);
        if (!existsSync(source) || !statSync(source).isFile()) {
            throw new Error(`备份文件不存在：${source}`);
        }

        let sourceCheck: DatabaseCheckResult;
        try {
            sourceCheck = this.inspectFile(source);
        } catch (error) {
            throw new Error(`备份文件无效：${errorMessage(error)}`);
        }
        if (!sourceCheck.ok) {
            throw new Error(`备份文件校验失败：${sourceCheck.integrityMessages.join('; ') || 'schema/foreign key error'}`);
        }

        const stagePath = `${livePath}.restore-${process.pid}-${randomUUID()}.tmp`;
        const rollbackPath = `${livePath}.rollback-${process.pid}-${randomUUID()}.tmp`;
        let safetyBackup: DatabaseBackupResult | null = null;
        let liveMoved = false;
        try {
            copyFileSync(source, stagePath, constants.COPYFILE_EXCL);
            chmodSync(stagePath, 0o600);

            const staged = new Database(stagePath);
            try {
                const stagedCheck = this.inspect(staged, stagePath);
                if (!stagedCheck.ok) throw new Error('暂存恢复文件校验失败');
                const now = Date.now();
                staged.query(
                    'INSERT OR REPLACE INTO gateway_lock (id, pid, acquired_at, heartbeat_at, ready_at) VALUES (1, ?, ?, ?, NULL)',
                ).run(process.pid, now, now);
            } finally {
                staged.close();
            }

            const sqlite = getSqlite();
            sqlite.exec('BEGIN IMMEDIATE');
            try {
                this.assertGatewaySafe(sqlite, false);
                this.assertNoRunningWork(sqlite);
                safetyBackup = this.writeSnapshot(sqlite, this.createBackupPath('pre-restore'));
                const now = Date.now();
                sqlite.query(
                    'INSERT OR REPLACE INTO gateway_lock (id, pid, acquired_at, heartbeat_at, ready_at) VALUES (1, ?, ?, ?, NULL)',
                ).run(process.pid, now, now);
                sqlite.exec('COMMIT');
            } catch (error) {
                if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
                throw error;
            }

            const checkpoint = sqlite.query('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number } | null;
            if (checkpoint && checkpoint.busy !== 0) {
                throw new DatabaseMaintenanceConflictError('数据库仍被其他连接占用，无法安全恢复');
            }
            closeDb();
            safeUnlink(`${livePath}-wal`);
            safeUnlink(`${livePath}-shm`);

            renameSync(livePath, rollbackPath);
            liveMoved = true;
            renameSync(stagePath, livePath);

            const restored = getSqlite();
            restored.exec('BEGIN IMMEDIATE');
            let recoveredRunningTasks = 0;
            let closedRunningRuns = 0;
            try {
                recoveredRunningTasks = this.scalar(
                    restored,
                    "SELECT COUNT(*) AS count FROM tasks WHERE status = 'running'",
                );
                closedRunningRuns = this.scalar(
                    restored,
                    "SELECT COUNT(*) AS count FROM task_runs WHERE status = 'running'",
                );
                const finishedAt = Math.floor(Date.now() / 1000);
                restored.query(`
                    UPDATE task_runs
                    SET status = 'failed', finished_at = ?,
                        log = CASE
                            WHEN log IS NULL OR log = '' THEN '数据库恢复时关闭遗留运行记录'
                            ELSE log || '\n数据库恢复时关闭遗留运行记录'
                        END
                    WHERE status = 'running'
                `).run(finishedAt);
                restored.exec(`
                    UPDATE tasks
                    SET status = 'pending', started_at = NULL, finished_at = NULL
                    WHERE status = 'running'
                `);
                restored.query('DELETE FROM gateway_lock WHERE pid = ?').run(process.pid);
                restored.exec('COMMIT');
            } catch (error) {
                if (restored.inTransaction) restored.exec('ROLLBACK');
                throw error;
            }

            const check = this.inspect(restored, livePath);
            if (!check.ok) throw new Error('恢复后的数据库未通过完整性校验');

            safeUnlink(rollbackPath);
            return {
                sourcePath: source,
                safetyBackupPath: safetyBackup.path,
                recoveredRunningTasks,
                closedRunningRuns,
                check,
            };
        } catch (error) {
            closeDb();
            safeUnlink(`${livePath}-wal`);
            safeUnlink(`${livePath}-shm`);
            safeUnlink(stagePath);
            safeUnlink(`${stagePath}-journal`);
            safeUnlink(`${stagePath}-wal`);
            safeUnlink(`${stagePath}-shm`);

            if (liveMoved && existsSync(rollbackPath)) {
                safeUnlink(livePath);
                renameSync(rollbackPath, livePath);
                try {
                    const original = getSqlite();
                    original.query('DELETE FROM gateway_lock WHERE pid = ?').run(process.pid);
                } catch {
                    // 最终错误会同时给出安全备份路径，供人工恢复。
                }
            } else if (existsSync(rollbackPath)) {
                safeUnlink(rollbackPath);
            } else {
                try {
                    getSqlite().query('DELETE FROM gateway_lock WHERE pid = ?').run(process.pid);
                } catch {
                    // 当前数据库仍在原位；保留原始错误。
                }
            }

            const backupHint = safetyBackup ? `；当前库安全备份：${safetyBackup.path}` : '';
            throw new Error(`恢复数据库失败，已尝试回滚${backupHint}：${errorMessage(error)}`);
        }
    }

    private static inspectFile(path: string): DatabaseCheckResult {
        let sqlite: Database;
        try {
            sqlite = new Database(path, { readonly: true, strict: true });
        } catch (error) {
            throw new Error(`无法打开备份文件：${errorMessage(error)}`);
        }
        try {
            return this.inspect(sqlite, path);
        } finally {
            sqlite.close();
        }
    }

    private static inspect(sqlite: Database, path: string): DatabaseCheckResult {
        const tableRows = sqlite.query(
            "SELECT name FROM sqlite_master WHERE type = 'table'",
        ).all() as Array<{ name: string }>;
        const tableNames = new Set(tableRows.map((row) => row.name));
        const missingTables = REQUIRED_TABLES.filter((table) => !tableNames.has(table));
        const integrityRows = sqlite.query('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>;
        const integrityMessages = integrityRows.map((row) => row.integrity_check);
        const foreignKeyViolations = sqlite.query('PRAGMA foreign_key_check').all().length;
        const journal = sqlite.query('PRAGMA journal_mode').get() as { journal_mode: string } | null;
        const counts = missingTables.length === 0
            ? this.readCounts(sqlite)
            : { tasks: 0, taskRuns: 0, taskTemplates: 0 };
        const runningTasks = missingTables.includes('tasks')
            ? 0
            : this.scalar(sqlite, "SELECT COUNT(*) AS count FROM tasks WHERE status = 'running'");
        const runningRuns = missingTables.includes('task_runs')
            ? 0
            : this.scalar(sqlite, "SELECT COUNT(*) AS count FROM task_runs WHERE status = 'running'");
        const sizeBytes = path === ':memory:' || !existsSync(path) ? sqlite.serialize().byteLength : statSync(path).size;

        return {
            ok: integrityMessages.length === 1
                && integrityMessages[0] === 'ok'
                && foreignKeyViolations === 0
                && missingTables.length === 0,
            path: normalizedPath(path),
            sizeBytes,
            journalMode: journal?.journal_mode ?? 'unknown',
            integrityMessages,
            foreignKeyViolations,
            missingTables,
            counts,
            runningTasks,
            runningRuns,
        };
    }

    private static writeSnapshot(sqlite: Database, outputPath: string): DatabaseBackupResult {
        const liveCheck = this.inspect(sqlite, DB_FILE_PATH);
        if (!liveCheck.ok) throw new Error('当前数据库未通过完整性校验，已拒绝创建备份');

        const output = normalizedPath(outputPath);
        if (DB_FILE_PATH !== ':memory:' && output === normalizedPath(DB_FILE_PATH)) {
            throw new Error('备份路径不能覆盖当前数据库');
        }
        if (existsSync(output)) throw new Error(`备份文件已存在：${output}`);

        mkdirSync(dirname(output), { recursive: true });
        const temporary = `${output}.tmp-${process.pid}-${randomUUID()}`;
        try {
            writeFileSync(temporary, sqlite.serialize(), { flag: 'wx', mode: 0o600 });
            const standalone = new Database(temporary, { readwrite: true, create: false });
            try {
                standalone.query('PRAGMA journal_mode = DELETE').get();
            } finally {
                standalone.close();
            }
            safeUnlink(`${temporary}-wal`);
            safeUnlink(`${temporary}-shm`);
            const check = this.inspectFile(temporary);
            if (!check.ok) throw new Error('新备份未通过完整性校验');
            renameSync(temporary, output);
            const finalCheck = { ...check, path: output, sizeBytes: statSync(output).size };
            return { path: output, sizeBytes: finalCheck.sizeBytes, check: finalCheck };
        } catch (error) {
            safeUnlink(temporary);
            safeUnlink(`${temporary}-wal`);
            safeUnlink(`${temporary}-shm`);
            throw error;
        }
    }

    private static createBackupPath(kind: 'backup' | 'pre-clear' | 'pre-restore'): string {
        const directory = DB_FILE_PATH === ':memory:' ? tmpdir() : dirname(normalizedPath(DB_FILE_PATH));
        const base = DB_FILE_PATH === ':memory:' ? 'supertask-memory' : basename(DB_FILE_PATH, '.db');
        return resolve(directory, `${base}.${kind}-${timestamp()}-${randomUUID().slice(0, 8)}.db`);
    }

    private static readCounts(sqlite: Database): DatabaseCounts {
        return {
            tasks: this.scalar(sqlite, 'SELECT COUNT(*) AS count FROM tasks'),
            taskRuns: this.scalar(sqlite, 'SELECT COUNT(*) AS count FROM task_runs'),
            taskTemplates: this.scalar(sqlite, 'SELECT COUNT(*) AS count FROM task_templates'),
        };
    }

    private static scalar(sqlite: Database, statement: string): number {
        const row = sqlite.query(statement).get() as CountRow | null;
        return Number(row?.count ?? 0);
    }

    private static assertGatewaySafe(sqlite: Database, allowCurrentGateway: boolean): void {
        const lock = sqlite.query('SELECT pid FROM gateway_lock WHERE id = 1').get() as GatewayLockRow | null;
        if (!lock || !isProcessAlive(lock.pid)) return;
        if (allowCurrentGateway && lock.pid === process.pid) return;
        throw new DatabaseMaintenanceConflictError(
            `Gateway PID ${lock.pid} 仍在运行，请先执行 pm2 stop supertask-gateway`,
        );
    }

    private static assertNoRunningWork(sqlite: Database): void {
        const runningTasks = this.scalar(sqlite, "SELECT COUNT(*) AS count FROM tasks WHERE status = 'running'");
        const runningRuns = this.scalar(sqlite, "SELECT COUNT(*) AS count FROM task_runs WHERE status = 'running'");
        if (runningTasks > 0 || runningRuns > 0) {
            throw new DatabaseMaintenanceConflictError(
                `存在运行中任务（tasks=${runningTasks}, task_runs=${runningRuns}），已拒绝危险操作`,
            );
        }
    }
}
