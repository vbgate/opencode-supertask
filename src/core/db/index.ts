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

function initDb() {
    const dataDir = dirname(DB_FILE_PATH);
    if (!existsSync(dataDir)) {
        mkdirSync(dataDir, { recursive: true });
    }
    _sqlite = new Database(DB_FILE_PATH);
    _sqlite.exec('PRAGMA journal_mode = WAL;');
    _sqlite.exec('PRAGMA busy_timeout = 5000;');
    if (!_migrationRan) {
        try {
            _db = migrateSqliteDatabase(_sqlite);
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
