import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import * as schema from './schema';
import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const DEFAULT_DB_PATH = join(homedir(), '.local/share/opencode/tasks.db');
export const DB_FILE_PATH = process.env.SUPERTASK_DB_PATH || DEFAULT_DB_PATH;
export { schema };

let _sqlite: Database | null = null;
let _db: ReturnType<typeof drizzle> | null = null;
let _migrationRan = false;

function getMigrationsFolder(): string {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    let dir = __dirname;
    for (let i = 0; i < 5; i++) {
        const candidate = join(dir, 'drizzle', 'meta', '_journal.json');
        if (existsSync(candidate)) {
            return join(dir, 'drizzle');
        }
        dir = dirname(dir);
    }
    return join(__dirname, '../../drizzle');
}

function ensureGatewayLock(sqliteDb: Database): void {
    sqliteDb.exec(`
        CREATE TABLE IF NOT EXISTS gateway_lock (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            pid INTEGER NOT NULL,
            acquired_at INTEGER NOT NULL,
            heartbeat_at INTEGER NOT NULL,
            ready_at INTEGER,
            version TEXT
        );
    `);
    const columns = sqliteDb.query('PRAGMA table_info(gateway_lock)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'ready_at')) {
        sqliteDb.exec('ALTER TABLE gateway_lock ADD COLUMN ready_at INTEGER;');
    }
    if (!columns.some((column) => column.name === 'version')) {
        sqliteDb.exec('ALTER TABLE gateway_lock ADD COLUMN version TEXT;');
    }
}

export function migrateSqliteDatabase(sqliteDb: Database): ReturnType<typeof drizzle> {
    ensureGatewayLock(sqliteDb);
    const drizzleDb = drizzle(sqliteDb, { schema });
    migrate(drizzleDb, { migrationsFolder: getMigrationsFolder() });
    sqliteDb.exec('PRAGMA foreign_keys = ON;');
    const violations = sqliteDb.query('PRAGMA foreign_key_check;').all();
    if (violations.length > 0) {
        throw new Error(`检测到 ${violations.length} 条孤立关联记录，请先修复数据再启动`);
    }
    return drizzleDb;
}

// 升级后 Gateway、插件和 CLI 可能同时首次打开数据库：drizzle 在事务外读取已应用迁移，
// 落后的一方会在自己的事务里重复执行同一迁移并整体回滚。重读迁移表后即为空操作，因此只对这类冲突有界重试。
const CONCURRENT_MIGRATION_PATTERN = /already exists|duplicate column name/i;

function migrateWithConcurrentOpenRetry(sqliteDb: Database): ReturnType<typeof drizzle> {
    for (let attempt = 1; ; attempt += 1) {
        try {
            return migrateSqliteDatabase(sqliteDb);
        } catch (error) {
            const message = error instanceof Error ? `${error.message} ${String(error.cause ?? '')}` : String(error);
            if (attempt >= 5 || !CONCURRENT_MIGRATION_PATTERN.test(message)) throw error;
            Bun.sleepSync(50 * attempt);
        }
    }
}

/** 新库切换 WAL 需要排他锁，且 SQLite 此时不走 busy handler；并发首次打开时有界重试。已是 WAL 时为空操作。 */
function enableWal(sqliteDb: Database): void {
    for (let attempt = 1; ; attempt += 1) {
        try {
            sqliteDb.exec('PRAGMA journal_mode = WAL;');
            return;
        } catch (error) {
            if (attempt >= 20 || !/database is locked/i.test(error instanceof Error ? error.message : String(error))) throw error;
            Bun.sleepSync(25 * attempt);
        }
    }
}

function initDb() {
    const dataDir = dirname(DB_FILE_PATH);
    if (!existsSync(dataDir)) {
        mkdirSync(dataDir, { recursive: true });
    }
    _sqlite = new Database(DB_FILE_PATH);
    _sqlite.exec('PRAGMA busy_timeout = 5000;');
    enableWal(_sqlite);
    if (!_migrationRan) {
        try {
            _db = migrateWithConcurrentOpenRetry(_sqlite);
            _migrationRan = true;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            _migrationRan = false;
            _sqlite.close();
            _sqlite = null;
            _db = null;
            console.error(`[supertask] migration failed: ${msg}`);
            throw new Error(`[supertask] DB migration failed: ${msg}`);
        }
    } else {
        _db = drizzle(_sqlite, { schema });
    }

    return _db;
}

export function getDb() {
    if (!_db) initDb();
    return _db!;
}

export function getSqlite() {
    if (!_sqlite) initDb();
    return _sqlite!;
}

export function closeDb() {
    if (_sqlite) {
        _sqlite.close();
        _sqlite = null;
        _db = null;
        _migrationRan = false;
    }
}

export const db = new Proxy({} as ReturnType<typeof drizzle>, {
    get(_, prop) {
        const target = getDb();
        const value = Reflect.get(target, prop);
        if (typeof value === 'function') return value.bind(target);
        return value;
    },
});

export const sqlite = new Proxy({} as Database, {
    get(_, prop) {
        const target = getSqlite();
        const value = Reflect.get(target, prop);
        if (typeof value === 'function') return value.bind(target);
        return value;
    },
});
