import { Database } from 'bun:sqlite';
import { randomUUID } from 'crypto';
import {
    chmodSync,
    existsSync,
    mkdirSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, resolve } from 'path';
import { DB_FILE_PATH, getSqlite, migrateSqliteDatabase } from '@core/db';
import { isProcessAlive } from '@core/process-control';

const REQUIRED_TABLES = ['gateway_lock', 'tasks', 'task_runs', 'task_templates'] as const;

interface CountRow {
    count: number;
}

interface GatewayLockRow {
    pid: number;
}

interface RestoreColumn {
    name: string;
    type: string;
    notNull: boolean;
    defaultValue: string | null;
    primaryKeyOrder: number;
}

interface RestoreTable {
    name: string;
    columns: RestoreColumn[];
}

interface RestoreTablePlan extends RestoreTable {
    sourceExists: boolean;
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

function quoteIdentifier(value: string): string {
    return `"${value.replaceAll('"', '""')}"`;
}

function columnDefinitionsMatch(left: RestoreColumn, right: RestoreColumn): boolean {
    return left.type.trim().toUpperCase() === right.type.trim().toUpperCase()
        && left.notNull === right.notNull
        && left.defaultValue === right.defaultValue
        && left.primaryKeyOrder === right.primaryKeyOrder;
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

            const businessTables = this.readRestoreTables(sqlite, 'main');
            sqlite.exec('PRAGMA defer_foreign_keys = ON');
            for (const table of businessTables.values()) {
                sqlite.exec(`DELETE FROM main.${quoteIdentifier(table.name)}`);
            }
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
        const stagePath = `${livePath}.restore-${process.pid}-${randomUUID()}.tmp`;
        let safetyBackup: DatabaseBackupResult | null = null;
        let attached = false;
        let committed = false;
        try {
            current.exec('BEGIN EXCLUSIVE');
            this.assertGatewaySafe(current, false);
            this.assertNoRunningWork(current);
            if (!existsSync(source)) {
                throw new Error(`备份文件不存在：${source}`);
            }
            const sourceStat = statSync(source);
            if (!sourceStat.isFile()) throw new Error(`备份路径不是文件：${source}`);
            const liveStat = statSync(livePath);
            if (sourceStat.dev === liveStat.dev && sourceStat.ino === liveStat.ino) {
                throw new Error('恢复来源不能是当前数据库的符号链接或硬链接别名');
            }

            let sourceCheck: DatabaseCheckResult;
            try {
                const sourceDatabase = new Database(source, { readonly: true, strict: true });
                try {
                    sourceDatabase.exec('BEGIN');
                    sourceCheck = this.inspect(sourceDatabase, source);
                    if (!sourceCheck.ok) {
                        throw new Error(
                            sourceCheck.integrityMessages.join('; ') || 'schema/foreign key error',
                        );
                    }
                    writeFileSync(stagePath, sourceDatabase.serialize(), {
                        flag: 'wx',
                        mode: 0o600,
                    });
                } finally {
                    if (sourceDatabase.inTransaction) sourceDatabase.exec('ROLLBACK');
                    sourceDatabase.close();
                }
            } catch (error) {
                throw new Error(`备份文件无效：${errorMessage(error)}`);
            }
            chmodSync(stagePath, 0o600);

            const staged = new Database(stagePath);
            try {
                staged.exec('PRAGMA journal_mode = DELETE;');
                staged.exec('PRAGMA busy_timeout = 5000;');
                migrateSqliteDatabase(staged);
                const stagedCheck = this.inspect(staged, stagePath);
                if (!stagedCheck.ok) throw new Error('暂存恢复文件校验失败');
            } finally {
                staged.close();
            }

            const sqlite = current;
            let recoveredRunningTasks = 0;
            let closedRunningRuns = 0;
            try {
                this.assertGatewaySafe(sqlite, false);
                this.assertNoRunningWork(sqlite);
                safetyBackup = this.writeSnapshot(sqlite, this.createBackupPath('pre-restore'));
                sqlite.query('ATTACH DATABASE ? AS restore_source').run(stagePath);
                attached = true;
                const restorePlan = this.buildRestorePlan(sqlite);
                recoveredRunningTasks = this.scalar(
                    sqlite,
                    "SELECT COUNT(*) AS count FROM restore_source.tasks WHERE status = 'running'",
                );
                closedRunningRuns = this.scalar(
                    sqlite,
                    "SELECT COUNT(*) AS count FROM restore_source.task_runs WHERE status = 'running'",
                );

                sqlite.exec('PRAGMA defer_foreign_keys = ON');
                for (const table of restorePlan) {
                    sqlite.exec(`DELETE FROM main.${quoteIdentifier(table.name)}`);
                }
                for (const table of restorePlan) {
                    if (!table.sourceExists) continue;
                    const columns = table.columns.map((column) => quoteIdentifier(column.name)).join(', ');
                    sqlite.exec(`
                        INSERT INTO main.${quoteIdentifier(table.name)} (${columns})
                        SELECT ${columns} FROM restore_source.${quoteIdentifier(table.name)}
                    `);
                }

                const liveTableNames = restorePlan.map((table) => table.name);
                const sourceTableNames = restorePlan
                    .filter((table) => table.sourceExists)
                    .map((table) => table.name);
                const livePlaceholders = liveTableNames.map(() => '?').join(', ');
                sqlite.query(
                    `DELETE FROM main.sqlite_sequence WHERE name IN (${livePlaceholders})`,
                ).run(...liveTableNames);
                if (sourceTableNames.length > 0) {
                    const sourcePlaceholders = sourceTableNames.map(() => '?').join(', ');
                    sqlite.query(`
                        INSERT INTO main.sqlite_sequence(name, seq)
                        SELECT name, seq FROM restore_source.sqlite_sequence
                        WHERE name IN (${sourcePlaceholders})
                    `).run(...sourceTableNames);
                }

                const finishedAt = Math.floor(Date.now() / 1000);
                sqlite.query(`
                    UPDATE task_runs
                    SET status = 'failed', finished_at = ?,
                        log = CASE
                            WHEN log IS NULL OR log = '' THEN '数据库恢复时关闭遗留运行记录'
                            ELSE log || '\n数据库恢复时关闭遗留运行记录'
                        END
                    WHERE status = 'running'
                `).run(finishedAt);
                sqlite.exec(`
                    UPDATE tasks
                    SET status = 'pending', started_at = NULL, finished_at = NULL
                    WHERE status = 'running'
                `);
                sqlite.exec('DELETE FROM gateway_lock');

                const violations = sqlite.query('PRAGMA foreign_key_check').all();
                if (violations.length > 0) {
                    throw new Error(`恢复数据包含 ${violations.length} 条外键违规`);
                }
                const transactionCheck = this.inspect(sqlite, livePath);
                if (!transactionCheck.ok) throw new Error('恢复后的数据库未通过完整性校验');

                sqlite.exec('COMMIT');
                committed = true;
            } catch (error) {
                if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
                throw error;
            } finally {
                if (attached && !sqlite.inTransaction) {
                    try {
                        sqlite.exec('DETACH DATABASE restore_source');
                    } catch {
                        // 连接关闭时 SQLite 仍会释放附件；不覆盖恢复结果。
                    }
                    attached = false;
                }
            }

            const check = this.inspect(sqlite, livePath);
            if (!check.ok) throw new Error('恢复后的数据库未通过完整性校验');

            return {
                sourcePath: source,
                safetyBackupPath: safetyBackup.path,
                recoveredRunningTasks,
                closedRunningRuns,
                check,
            };
        } catch (error) {
            if (current.inTransaction) current.exec('ROLLBACK');
            safeUnlink(stagePath);
            safeUnlink(`${stagePath}-journal`);
            safeUnlink(`${stagePath}-wal`);
            safeUnlink(`${stagePath}-shm`);

            const backupHint = safetyBackup ? `；当前库安全备份：${safetyBackup.path}` : '';
            const rollbackHint = committed ? '；事务已提交，未自动覆盖后续写入' : '；事务已回滚';
            throw new Error(`恢复数据库失败${rollbackHint}${backupHint}：${errorMessage(error)}`);
        } finally {
            safeUnlink(stagePath);
            safeUnlink(`${stagePath}-journal`);
            safeUnlink(`${stagePath}-wal`);
            safeUnlink(`${stagePath}-shm`);
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

    private static buildRestorePlan(sqlite: Database): RestoreTablePlan[] {
        const liveTables = this.readRestoreTables(sqlite, 'main');
        const sourceTables = this.readRestoreTables(sqlite, 'restore_source');

        for (const [tableName, sourceTable] of sourceTables) {
            const liveTable = liveTables.get(tableName);
            if (!liveTable) {
                throw new Error(`恢复来源包含当前数据库不认识的业务表：${tableName}`);
            }
            const liveColumns = new Map(liveTable.columns.map((column) => [column.name, column]));
            for (const sourceColumn of sourceTable.columns) {
                const liveColumn = liveColumns.get(sourceColumn.name);
                if (!liveColumn) {
                    throw new Error(
                        `恢复来源的表 ${tableName} 包含当前数据库不认识的可写列：${sourceColumn.name}`,
                    );
                }
                if (!columnDefinitionsMatch(liveColumn, sourceColumn)) {
                    throw new Error(`恢复来源的表 ${tableName}.${sourceColumn.name} 与当前数据库定义不兼容`);
                }
            }
        }

        const plan: RestoreTablePlan[] = [];
        for (const [tableName, liveTable] of liveTables) {
            const sourceTable = sourceTables.get(tableName);
            if (!sourceTable) {
                plan.push({ ...liveTable, columns: [], sourceExists: false });
                continue;
            }

            const sourceColumns = new Map(sourceTable.columns.map((column) => [column.name, column]));
            for (const liveColumn of liveTable.columns) {
                if (sourceColumns.has(liveColumn.name)) continue;
                if (liveColumn.primaryKeyOrder > 0 || (liveColumn.notNull && liveColumn.defaultValue == null)) {
                    throw new Error(
                        `当前数据库的表 ${tableName}.${liveColumn.name} 无法从旧备份安全补默认值`,
                    );
                }
            }
            plan.push({
                name: tableName,
                columns: sourceTable.columns,
                sourceExists: true,
            });
        }
        return plan;
    }

    private static readRestoreTables(
        sqlite: Database,
        databaseName: 'main' | 'restore_source',
    ): Map<string, RestoreTable> {
        const tableRows = sqlite.query(`
            SELECT name
            FROM ${databaseName}.sqlite_schema
            WHERE type = 'table'
              AND name NOT LIKE 'sqlite_%'
              AND name NOT IN ('gateway_lock', '__drizzle_migrations')
            ORDER BY name
        `).all() as Array<{ name: string }>;
        const result = new Map<string, RestoreTable>();
        for (const row of tableRows) {
            const columns = sqlite.query(
                `PRAGMA ${databaseName}.table_xinfo(${quoteIdentifier(row.name)})`,
            ).all() as Array<{
                name: string;
                type: string;
                notnull: number;
                dflt_value: string | null;
                pk: number;
                hidden: number;
            }>;
            result.set(row.name, {
                name: row.name,
                columns: columns
                    .filter((column) => column.hidden === 0)
                    .map((column) => ({
                        name: column.name,
                        type: column.type,
                        notNull: column.notnull !== 0,
                        defaultValue: column.dflt_value,
                        primaryKeyOrder: column.pk,
                    })),
            });
        }
        return result;
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
            `Gateway PID ${lock.pid} 仍在运行，但未确认由当前数据库对应的 PM2 进程管理；请先停止该 Gateway（PM2 可执行 pm2 stop supertask-gateway）`,
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
