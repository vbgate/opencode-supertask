import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import * as schema from './schema';
import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';

export const DB_FILE_PATH = join(homedir(), '.local/share/opencode/tasks.db');
export { schema };

let _sqlite: Database | null = null;
let _db: ReturnType<typeof drizzle> | null = null;

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
