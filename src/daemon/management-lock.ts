import { Database } from 'bun:sqlite';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

export class ManagementLockBusyError extends Error {
    constructor() {
        super('Gateway management lock is busy');
        this.name = 'ManagementLockBusyError';
    }
}

function isBusyError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const code = (error as Error & { code?: string }).code;
    return code === 'SQLITE_BUSY' || /database is locked/i.test(error.message);
}

/**
 * Serializes PM2 lifecycle changes with an OS-backed SQLite write lock.
 * The transaction is held for the complete action and is released by SQLite
 * automatically if the owning process exits or is killed.
 */
export function withExclusiveManagementLock<T>(
    path: string,
    timeoutMs: number,
    action: () => T,
): T {
    mkdirSync(dirname(path), { recursive: true });
    const database = new Database(path, { create: true });
    const normalizedTimeout = Number.isFinite(timeoutMs) && timeoutMs >= 0
        ? Math.floor(timeoutMs)
        : 0;
    database.exec(`PRAGMA busy_timeout = ${normalizedTimeout}`);

    try {
        try {
            database.exec('BEGIN IMMEDIATE');
        } catch (error) {
            if (isBusyError(error)) throw new ManagementLockBusyError();
            throw error;
        }

        try {
            const result = action();
            database.exec('COMMIT');
            return result;
        } catch (error) {
            try {
                database.exec('ROLLBACK');
            } catch {}
            throw error;
        }
    } finally {
        database.close();
    }
}
