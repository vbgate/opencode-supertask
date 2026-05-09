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
    return join(__dirname, '../../../drizzle');
}

function initDb() {
    const dataDir = dirname(DB_FILE_PATH);
    if (!existsSync(dataDir)) {
        mkdirSync(dataDir, { recursive: true });
    }
    _sqlite = new Database(DB_FILE_PATH);
    _sqlite.exec('PRAGMA journal_mode = WAL;');
    _sqlite.exec('PRAGMA busy_timeout = 5000;');
    _sqlite.exec(`
        CREATE TABLE IF NOT EXISTS gateway_lock (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            pid INTEGER NOT NULL,
            acquired_at INTEGER NOT NULL,
            heartbeat_at INTEGER NOT NULL
        );
    `);
    _db = drizzle(_sqlite, { schema });

    if (!_migrationRan) {
        _migrationRan = true;
        try {
            migrate(_db, { migrationsFolder: getMigrationsFolder() });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[supertask] migration failed: ${msg}`);
            throw new Error(`[supertask] DB migration failed: ${msg}`);
        }
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
