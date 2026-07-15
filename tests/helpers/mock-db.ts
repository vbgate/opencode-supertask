import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import * as schema from '../../src/core/db/schema';
import { mock } from 'bun:test';

export function setupTestDb() {
    const sqlite = new Database(':memory:');
    sqlite.exec('PRAGMA journal_mode = WAL;');
    sqlite.exec('PRAGMA busy_timeout = 5000;');

    sqlite.exec(`
        CREATE TABLE IF NOT EXISTS gateway_lock (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            pid INTEGER NOT NULL,
            acquired_at INTEGER NOT NULL,
            heartbeat_at INTEGER NOT NULL,
            ready_at INTEGER
        );
    `);

    sqlite.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            agent TEXT NOT NULL,
            model TEXT DEFAULT 'default',
            prompt TEXT NOT NULL,
            cwd TEXT,
            category TEXT DEFAULT 'general',
            importance INTEGER DEFAULT 3,
            urgency INTEGER DEFAULT 3,
            batch_id TEXT,
            depends_on INTEGER,
            status TEXT DEFAULT 'pending',
            created_at INTEGER,
            started_at INTEGER,
            finished_at INTEGER,
            result_log TEXT,
            retry_count INTEGER DEFAULT 0,
            max_retries INTEGER DEFAULT 3,
            retry_backoff_ms INTEGER DEFAULT 30000,
            retry_after INTEGER,
            timeout_ms INTEGER,
            template_id INTEGER,
            scheduled_at INTEGER
        );
    `);

    sqlite.exec(`
        CREATE TABLE IF NOT EXISTS task_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id INTEGER NOT NULL REFERENCES tasks(id),
            session_id TEXT,
            model TEXT,
            status TEXT DEFAULT 'running',
            started_at INTEGER,
            finished_at INTEGER,
            log TEXT,
            locked_at INTEGER,
            locked_by TEXT,
            heartbeat_at INTEGER,
            worker_pid INTEGER,
            child_pid INTEGER
        );
    `);

    sqlite.exec(`
        CREATE TABLE IF NOT EXISTS task_templates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            agent TEXT NOT NULL,
            model TEXT DEFAULT 'default',
            prompt TEXT NOT NULL,
            cwd TEXT,
            category TEXT DEFAULT 'general',
            importance INTEGER DEFAULT 3,
            urgency INTEGER DEFAULT 3,
            batch_id TEXT,
            schedule_type TEXT NOT NULL,
            cron_expr TEXT,
            interval_ms INTEGER,
            run_at INTEGER,
            max_instances INTEGER DEFAULT 1,
            max_retries INTEGER DEFAULT 3,
            retry_backoff_ms INTEGER DEFAULT 30000,
            timeout_ms INTEGER,
            last_run_at INTEGER,
            next_run_at INTEGER,
            enabled INTEGER DEFAULT 1,
            created_at INTEGER DEFAULT 0,
            updated_at INTEGER DEFAULT 0
        );
    `);

    const testDb = drizzle(sqlite, { schema });

    mock.module('../../src/core/db', () => ({
        db: testDb,
        sqlite,
        schema,
        getDb: () => testDb,
        getSqlite: () => sqlite,
        closeDb: () => { sqlite.close(); },
        DB_FILE_PATH: ':memory:',
    }));

    return { db: testDb, sqlite, schema };
}
