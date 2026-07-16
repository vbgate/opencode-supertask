import { describe, expect, test } from 'bun:test';
import { spawn } from 'child_process';
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

    test('心跳过期但 PID 仍存活时拒绝抢锁', async () => {
        setupTestDb();
        const holder = spawn(process.execPath, [
            '-e', 'setTimeout(() => {}, 10000)', '/tmp/supertask/gateway/index.ts',
        ], {
            stdio: 'ignore',
        });
        await new Promise<void>((resolve, reject) => {
            holder.once('spawn', resolve);
            holder.once('error', reject);
        });
        try {
            const { sqlite } = await import('../src/core/db');
            sqlite.exec(
                'INSERT INTO gateway_lock (id, pid, acquired_at, heartbeat_at, ready_at) VALUES (1, ?, ?, ?, ?)',
                [holder.pid!, Date.now() - 60_000, Date.now() - 60_000, Date.now() - 60_000],
            );
            const { acquireLock } = await import('../src/gateway/index');

            expect(acquireLock()).toBe(false);
            expect(sqlite.prepare('SELECT pid FROM gateway_lock WHERE id = 1').get()).toEqual({
                pid: holder.pid!,
            });
        } finally {
            holder.kill('SIGKILL');
            await new Promise<void>((resolve) => holder.once('close', () => resolve()));
        }
    });

    test('前台 CLI Gateway 心跳过期时仍识别为合法 owner', async () => {
        setupTestDb();
        const holder = spawn(process.execPath, [
            '-e', 'setTimeout(() => {}, 10000)', '/tmp/supertask/cli/index.ts', 'gateway',
        ], {
            stdio: 'ignore',
        });
        await new Promise<void>((resolve, reject) => {
            holder.once('spawn', resolve);
            holder.once('error', reject);
        });
        try {
            const { sqlite } = await import('../src/core/db');
            sqlite.exec(
                'INSERT INTO gateway_lock (id, pid, acquired_at, heartbeat_at, ready_at) VALUES (1, ?, ?, ?, ?)',
                [holder.pid!, Date.now() - 60_000, Date.now() - 60_000, Date.now() - 60_000],
            );
            const { acquireLock } = await import('../src/gateway/index');

            expect(acquireLock()).toBe(false);
            expect(sqlite.prepare('SELECT pid FROM gateway_lock WHERE id = 1').get()).toEqual({
                pid: holder.pid!,
            });
        } finally {
            holder.kill('SIGKILL');
            await new Promise<void>((resolve) => holder.once('close', () => resolve()));
        }
    });

    test('陈旧锁的 PID 被无关进程复用时安全接管', async () => {
        setupTestDb();
        const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
            stdio: 'ignore',
        });
        await new Promise<void>((resolve, reject) => {
            holder.once('spawn', resolve);
            holder.once('error', reject);
        });
        try {
            const { sqlite } = await import('../src/core/db');
            sqlite.exec(
                'INSERT INTO gateway_lock (id, pid, acquired_at, heartbeat_at, ready_at) VALUES (1, ?, ?, ?, ?)',
                [holder.pid!, Date.now() - 60_000, Date.now() - 60_000, Date.now() - 60_000],
            );
            const { acquireLock, releaseLock } = await import('../src/gateway/index');

            expect(acquireLock()).toBe(true);
            expect(sqlite.prepare('SELECT pid FROM gateway_lock WHERE id = 1').get()).toEqual({
                pid: process.pid,
            });
            releaseLock();
        } finally {
            holder.kill('SIGKILL');
            await new Promise<void>((resolve) => holder.once('close', () => resolve()));
        }
    });

    test('锁 owner 改变后旧 owner 的心跳更新失败', async () => {
        setupTestDb();
        const { sqlite } = await import('../src/core/db');
        const { acquireLock, updateLockHeartbeat } = await import('../src/gateway/index');
        expect(acquireLock()).toBe(true);
        sqlite.query('UPDATE gateway_lock SET pid = ? WHERE id = 1').run(2_147_483_647);

        expect(updateLockHeartbeat()).toBe(false);
    });
});
