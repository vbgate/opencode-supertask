import { describe, test, expect, beforeEach } from 'bun:test';
import { setupTestDb } from './helpers/mock-db';
import { checkHeartbeats } from '../src/gateway/watchdog/heartbeat';
import { cleanupOldRecords } from '../src/gateway/watchdog/cleanup';
import { TaskService } from '../src/core/services/task.service';
import { TaskRunService } from '../src/core/services/task-run.service';

async function createTask(overrides: Record<string, unknown> = {}) {
    return TaskService.add({
        name: '看门狗测试',
        agent: 'test-agent',
        prompt: '测试',
        ...overrides,
    });
}

describe('checkHeartbeats', () => {
    beforeEach(() => {
        setupTestDb();
    });

    test('无 stale run 时什么都不做', async () => {
        await checkHeartbeats(-100000);
    });

    test('检测 stale run 并标记为 dead_letter（达到最大重试）', async () => {
        const task = await createTask({ maxRetries: 0 });
        await TaskService.start(task.id);
        await TaskRunService.create({ taskId: task.id, status: 'running' });

        await checkHeartbeats(-100000);

        const updatedTask = await TaskService.getById(task.id);
        expect(updatedTask!.status).toBe('dead_letter');
    });

    test('检测 stale run 并重新安排重试（未达最大重试）', async () => {
        const task = await createTask({ maxRetries: 3 });
        await TaskService.start(task.id);
        await TaskRunService.create({ taskId: task.id, status: 'running' });

        await checkHeartbeats(-100000);

        const updatedTask = await TaskService.getById(task.id);
        expect(updatedTask!.status).toBe('pending');
        expect(updatedTask!.retryAfter).not.toBeNull();
        expect(updatedTask!.retryCount).toBe(1);
    });

    test('心跳超时使用任务自己的退避基础间隔', async () => {
        const task = await createTask({ maxRetries: 1, retryBackoffMs: 5000 });
        await TaskService.start(task.id);
        await TaskRunService.create({ taskId: task.id, status: 'running' });
        const before = Date.now();

        await checkHeartbeats(-100000);

        const updatedTask = await TaskService.getById(task.id);
        expect(updatedTask!.retryAfter!).toBeGreaterThanOrEqual(before + 5000);
        expect(updatedTask!.retryAfter!).toBeLessThanOrEqual(Date.now() + 5000);
    });

    test('多次心跳超时后达到 dead_letter', async () => {
        const task = await createTask({ maxRetries: 1 });
        await TaskService.start(task.id);
        await TaskRunService.create({ taskId: task.id, status: 'running' });

        await checkHeartbeats(-100000);

        let updatedTask = await TaskService.getById(task.id);
        expect(updatedTask!.status).toBe('pending');
        expect(updatedTask!.retryCount).toBe(1);

        await TaskService.start(task.id);
        await TaskRunService.create({ taskId: task.id, status: 'running' });

        await checkHeartbeats(-100000);

        updatedTask = await TaskService.getById(task.id);
        expect(updatedTask!.status).toBe('dead_letter');
        expect(updatedTask!.retryCount).toBe(2);
    });

    test('stale run 的 run 记录标记为 failed', async () => {
        const task = await createTask({ maxRetries: 3 });
        await TaskService.start(task.id);
        const run = await TaskRunService.create({ taskId: task.id, status: 'running' });

        await checkHeartbeats(-100000);

        const updatedRun = await TaskRunService.getById(run.id);
        expect(updatedRun!.status).toBe('failed');
        expect(updatedRun!.log).toContain('心跳超时');
    });
});

describe('cleanupOldRecords', () => {
    beforeEach(() => {
        setupTestDb();
    });

    test('清理已完成的旧任务', async () => {
        const task = await createTask();
        await TaskService.start(task.id);
        await TaskService.done(task.id, '完成');

        const deleted = await cleanupOldRecords(-1);
        expect(deleted).toBe(1);

        const found = await TaskService.getById(task.id);
        expect(found).toBeNull();
    });

    test('清理失败和 dead_letter 的旧任务', async () => {
        const t1 = await createTask({ name: 'T1', maxRetries: 1 });
        await TaskService.start(t1.id);
        await TaskService.fail(t1.id, '失败');

        const t2 = await createTask({ name: 'T2', maxRetries: 1 });
        await TaskService.start(t2.id);
        await TaskService.fail(t2.id, '死信', {}, { setDeadLetter: true });

        const deleted = await cleanupOldRecords(-1);
        expect(deleted).toBe(2);
    });

    test('不清理 pending/running 任务', async () => {
        const t1 = await createTask({ name: 'P' });
        const t2 = await createTask({ name: 'R' });
        await TaskService.start(t2.id);

        await cleanupOldRecords(-1);

        const found1 = await TaskService.getById(t1.id);
        const found2 = await TaskService.getById(t2.id);
        expect(found1).not.toBeNull();
        expect(found2).not.toBeNull();
    });

    test('同时清理关联的 run 记录', async () => {
        const task = await createTask();
        await TaskService.start(task.id);
        const run = await TaskRunService.create({ taskId: task.id, status: 'running' });
        await TaskRunService.done(run.id);
        await TaskService.done(task.id);

        await cleanupOldRecords(-1);

        const runs = await TaskRunService.listByTaskId(task.id);
        expect(runs.length).toBe(0);
    });
});
