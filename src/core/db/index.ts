import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import * as schema from './schema';
import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';

const DB_PATH = join(homedir(), '.local/share/opencode/tasks.db');

const dataDir = dirname(DB_PATH);
if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
}

const sqlite = new Database(DB_PATH);

sqlite.exec('PRAGMA journal_mode = WAL;');
sqlite.exec('PRAGMA busy_timeout = 5000;');

sqlite.exec(`
    CREATE TABLE IF NOT EXISTS gateway_lock (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        pid INTEGER NOT NULL,
        acquired_at INTEGER NOT NULL,
        heartbeat_at INTEGER NOT NULL
    );
`);

export const db = drizzle(sqlite, { schema });
export { schema };
export function closeDb() {
    sqlite.close();
}
export const DB_FILE_PATH = DB_PATH;
export { sqlite };
