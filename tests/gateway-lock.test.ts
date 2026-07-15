import { describe, expect, test } from 'bun:test';
import { setupTestDb } from './helpers/mock-db';

describe('Gateway 单实例锁', () => {
    test('新鲜锁记录的 PID 已不存在时立即接管', async () => {
        setupTestDb();
        const { sqlite } = await import('../src/core/db');
        const missingPid = 2_147_483_647;
        sqlite.exec(
            'INSERT INTO gateway_lock (id, pid, acquired_at, heartbeat_at, ready_at) VALUES (1, ?, ?, ?, ?)',
            [missingPid, Date.now(), Date.now(), Date.now()],
        );
        const { acquireLock, releaseLock } = await import('../src/gateway/index');

        expect(acquireLock()).toBe(true);
        expect(sqlite.prepare('SELECT pid FROM gateway_lock WHERE id = 1').get()).toEqual({
            pid: process.pid,
        });
        releaseLock();
    });
});
