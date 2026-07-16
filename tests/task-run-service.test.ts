import { describe, test, expect, beforeEach } from 'bun:test';
import { setupTestDb } from './helpers/mock-db';
import { TaskService } from '../src/core/services/task.service';
import { TaskRunService } from '../src/core/services/task-run.service';

async function createTask(overrides: Record<string, unknown> = {}) {
    return TaskService.add({
        name: '测试任务',
        agent: 'test-agent',
        prompt: '测试',
        ...overrides,
    });
}

describe('TaskRunService', () => {
    beforeEach(() => {
        setupTestDb();
    });

    describe('create', () => {
        test('创建运行记录', async () => {
            const task = await createTask();
            const run = await TaskRunService.create({
                taskId: task.id,
                model: 'glm-4',
                status: 'running',
            });
            expect(run.id).toBeGreaterThan(0);
            expect(run.taskId).toBe(task.id);
            expect(run.model).toBe('glm-4');
            expect(run.status).toBe('running');
            expect(run.startedAt).not.toBeNull();
        });
    });

    describe('updateSessionId', () => {
        test('更新 sessionId', async () => {
            const task = await createTask();
            const run = await TaskRunService.create({ taskId: task.id, status: 'running' });
            const updated = await TaskRunService.updateSessionId(run.id, 'ses_abc123');
            expect(updated).not.toBeNull();
            expect(updated!.sessionId).toBe('ses_abc123');
        });

        test('不存在的 runId 返回 null', async () => {
            const result = await TaskRunService.updateSessionId(99999, 'ses_x');
            expect(result).toBeNull();
        });
    });

    describe('done', () => {
        test('标记为 done', async () => {
            const task = await createTask();
            const run = await TaskRunService.create({ taskId: task.id, status: 'running' });
            const finished = await TaskRunService.done(run.id, '执行成功');
            expect(finished).not.toBeNull();
            expect(finished!.status).toBe('done');
            expect(finished!.finishedAt).not.toBeNull();
            expect(finished!.log).toBe('执行成功');
        });
    });

    test('执行记录终态不能被迟到事件覆盖', async () => {
        const task = await createTask();
        const run = await TaskRunService.create({ taskId: task.id, status: 'running' });
        await TaskRunService.fail(run.id, '看门狗已判定失败');

        expect(await TaskRunService.done(run.id, '迟到的 close 事件')).toBeNull();
        const current = await TaskRunService.getById(run.id);
        expect(current!.status).toBe('failed');
        expect(current!.log).toBe('看门狗已判定失败');
    });

    describe('fail', () => {
        test('标记为 failed', async () => {
            const task = await createTask();
            const run = await TaskRunService.create({ taskId: task.id, status: 'running' });
            const failed = await TaskRunService.fail(run.id, '执行失败');
            expect(failed).not.toBeNull();
            expect(failed!.status).toBe('failed');
            expect(failed!.finishedAt).not.toBeNull();
            expect(failed!.log).toBe('执行失败');
        });
    });

    describe('heartbeat', () => {
        test('更新心跳时间', async () => {
            const task = await createTask();
            const run = await TaskRunService.create({ taskId: task.id, status: 'running' });
            const before = Date.now();
            const updated = await TaskRunService.heartbeat(run.id);
            expect(updated).not.toBeNull();
            expect(updated!.heartbeatAt!).toBeGreaterThanOrEqual(before);
        });

        test('不更新非 running 状态的心跳', async () => {
            const task = await createTask();
            const run = await TaskRunService.create({ taskId: task.id, status: 'running' });
            await TaskRunService.done(run.id);
            const updated = await TaskRunService.heartbeat(run.id);
            expect(updated).toBeNull();
        });
    });

    describe('updatePid', () => {
        test('更新 PID 信息', async () => {
            const task = await createTask();
            const run = await TaskRunService.create({ taskId: task.id, status: 'running' });
            const updated = await TaskRunService.updatePid(run.id, 1000, 2000);
            expect(updated).not.toBeNull();
            expect(updated!.workerPid).toBe(1000);
            expect(updated!.childPid).toBe(2000);
            expect(updated!.lockedAt).not.toBeNull();
            expect(updated!.lockedBy).toContain('gateway-');
        });
    });

    describe('getById', () => {
        test('获取存在的运行记录', async () => {
            const task = await createTask();
            const run = await TaskRunService.create({ taskId: task.id, status: 'running' });
            const found = await TaskRunService.getById(run.id);
            expect(found).not.toBeNull();
            expect(found!.id).toBe(run.id);
        });

        test('不存在的 ID 返回 null', async () => {
            const found = await TaskRunService.getById(99999);
            expect(found).toBeNull();
        });
    });

    describe('listByTaskId', () => {
        test('按 taskId 列出所有运行记录', async () => {
            const task = await createTask();
            const r1 = await TaskRunService.create({ taskId: task.id, status: 'running' });
            const r2 = await TaskRunService.create({ taskId: task.id, status: 'running' });

            const runs = await TaskRunService.listByTaskId(task.id);
            expect(runs.length).toBe(2);
            expect(runs.map((r) => r.id)).toContain(r1.id);
            expect(runs.map((r) => r.id)).toContain(r2.id);
        });

        test('无运行记录返回空数组', async () => {
            const runs = await TaskRunService.listByTaskId(99999);
            expect(runs).toEqual([]);
        });
    });

    describe('getLatestByTaskId', () => {
        test('返回最新的运行记录', async () => {
            const task = await createTask();
            await TaskRunService.create({ taskId: task.id, status: 'running' });
            const r2 = await TaskRunService.create({ taskId: task.id, status: 'running' });

            const latest = await TaskRunService.getLatestByTaskId(task.id);
            expect(latest).not.toBeNull();
            expect(latest!.id).toBe(r2.id);
        });

        test('无记录返回 null', async () => {
            const latest = await TaskRunService.getLatestByTaskId(99999);
            expect(latest).toBeNull();
        });
    });

    describe('getLatestByTaskIds', () => {
        test('批量获取最新运行记录', async () => {
            const t1 = await createTask({ name: 'T1' });
            const t2 = await createTask({ name: 'T2' });
            await TaskRunService.create({ taskId: t1.id, status: 'running' });
            const r2 = await TaskRunService.create({ taskId: t2.id, status: 'running' });

            const map = await TaskRunService.getLatestByTaskIds([t1.id, t2.id]);
            expect(map.size).toBe(2);
            expect(map.get(t2.id)!.id).toBe(r2.id);
        });

        test('同秒多次执行用较大 ID 确定最新记录', async () => {
            const task = await createTask({ name: '同秒执行' });
            await TaskRunService.create({ taskId: task.id, status: 'running' });
            const latestRun = await TaskRunService.create({ taskId: task.id, status: 'running' });

            const map = await TaskRunService.getLatestByTaskIds([task.id]);
            expect(map.get(task.id)!.id).toBe(latestRun.id);
        });

        test('空数组返回空 Map', async () => {
            const map = await TaskRunService.getLatestByTaskIds([]);
            expect(map.size).toBe(0);
        });
    });

    describe('getStaleRuns', () => {
        test('检测心跳超时的运行（无心跳 + startedAt 超时）', async () => {
            const task = await createTask();
            const run = await TaskRunService.create({ taskId: task.id, status: 'running' });

            const stale = await TaskRunService.getStaleRuns(-100000);
            expect(stale.length).toBe(1);
            expect(stale[0].runId).toBe(run.id);
            expect(stale[0].taskId).toBe(task.id);
        });

        test('检测心跳超时的运行（有心跳但过期）', async () => {
            const task = await createTask();
            const run = await TaskRunService.create({ taskId: task.id, status: 'running' });
            await TaskRunService.heartbeat(run.id);

            const stale = await TaskRunService.getStaleRuns(-100000);
            expect(stale.length).toBe(1);
        });

        test('正常心跳的不算 stale', async () => {
            const task = await createTask();
            await TaskRunService.create({ taskId: task.id, status: 'running' });

            const stale = await TaskRunService.getStaleRuns(3600000);
            expect(stale.length).toBe(0);
        });

        test('执行所有者 PID 已退出时无需等待心跳超时', async () => {
            const task = await TaskService.add({ name: '所有者退出任务', agent: 'a', prompt: 'p' });
            await TaskService.start(task.id);
            const run = await TaskRunService.create({ taskId: task.id, status: 'running' });
            await TaskRunService.updatePid(run.id, 2_147_483_647, 0);

            const stale = await TaskRunService.getStaleRuns(86_400_000);
            expect(stale.map((item) => item.runId)).toContain(run.id);
        });

        test('非 running 状态不算 stale', async () => {
            const task = await createTask();
            const run = await TaskRunService.create({ taskId: task.id, status: 'running' });
            await TaskRunService.done(run.id);

            const stale = await TaskRunService.getStaleRuns(0);
            expect(stale.length).toBe(0);
        });
    });

    describe('getRunningRunByTaskId', () => {
        test('获取正在运行的记录', async () => {
            const task = await createTask();
            const run = await TaskRunService.create({ taskId: task.id, status: 'running' });

            const found = await TaskRunService.getRunningRunByTaskId(task.id);
            expect(found).not.toBeNull();
            expect(found!.id).toBe(run.id);
        });

        test('无 running 记录返回 null', async () => {
            const task = await createTask();
            const run = await TaskRunService.create({ taskId: task.id, status: 'running' });
            await TaskRunService.done(run.id);

            const found = await TaskRunService.getRunningRunByTaskId(task.id);
            expect(found).toBeNull();
        });
    });

    describe('deleteByTaskIds', () => {
        test('按任务 ID 批量删除运行记录', async () => {
            const t1 = await createTask({ name: 'T1' });
            const t2 = await createTask({ name: 'T2' });
            await TaskRunService.create({ taskId: t1.id, status: 'running' });
            await TaskRunService.create({ taskId: t2.id, status: 'running' });

            const count = await TaskRunService.deleteByTaskIds([t1.id, t2.id]);
            expect(count).toBe(2);

            const runs1 = await TaskRunService.listByTaskId(t1.id);
            expect(runs1).toEqual([]);
        });

        test('空数组返回 0', async () => {
            const count = await TaskRunService.deleteByTaskIds([]);
            expect(count).toBe(0);
        });
    });

    describe('getAllRunningRuns', () => {
        test('获取所有 running 状态的记录', async () => {
            const t1 = await createTask({ name: 'T1' });
            const t2 = await createTask({ name: 'T2' });
            await TaskRunService.create({ taskId: t1.id, status: 'running' });
            await TaskRunService.create({ taskId: t2.id, status: 'running' });

            const runs = await TaskRunService.getAllRunningRuns();
            expect(runs.length).toBe(2);
        });

        test('不包含非 running 状态', async () => {
            const task = await createTask();
            const run = await TaskRunService.create({ taskId: task.id, status: 'running' });
            await TaskRunService.done(run.id);

            const runs = await TaskRunService.getAllRunningRuns();
            expect(runs.length).toBe(0);
        });
    });

    describe('TaskRunService 与 TaskService 联动', () => {
        test('任务完成全生命周期：add→start→create run→done run→done task', async () => {
            const task = await createTask({ name: '完整生命周期' });
            await TaskService.start(task.id);

            const run = await TaskRunService.create({
                taskId: task.id,
                status: 'running',
                model: 'glm-4',
            });
            expect(run.status).toBe('running');

            await TaskRunService.done(run.id, '运行完成');
            await TaskService.done(task.id, '任务完成');

            const updatedTask = await TaskService.getById(task.id);
            expect(updatedTask!.status).toBe('done');

            const updatedRun = await TaskRunService.getById(run.id);
            expect(updatedRun!.status).toBe('done');
        });

        test('任务失败全生命周期：add→start→create run→fail run→fail task', async () => {
            const task = await createTask({ name: '失败生命周期', maxRetries: 3 });
            await TaskService.start(task.id);

            const run = await TaskRunService.create({
                taskId: task.id,
                status: 'running',
            });

            await TaskRunService.fail(run.id, '执行异常');
            await TaskService.fail(task.id, '执行异常');

            const updatedTask = await TaskService.getById(task.id);
            expect(updatedTask!.status).toBe('failed');
            expect(updatedTask!.retryCount).toBe(1);

            const updatedRun = await TaskRunService.getById(run.id);
            expect(updatedRun!.status).toBe('failed');
        });
    });
});
