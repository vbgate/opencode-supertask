import { beforeEach, describe, expect, test } from 'bun:test';
import { setupTestDb } from './helpers/mock-db';
import { TaskService } from '../src/core/services/task.service';
import { TaskRunService } from '../src/core/services/task-run.service';
import { TaskTemplateService } from '../src/core/services/task-template.service';
import { cloneTaskFromTemplate } from '../src/gateway/scheduler/job-templates';

describe('可靠性回归', () => {
    beforeEach(() => {
        setupTestDb();
    });

    test('只有 running 任务可以进入 done 或 failed，终态不能互相覆盖', async () => {
        const pending = await TaskService.add({
            name: '状态机测试',
            agent: 'test-agent',
            prompt: '验证非法状态转换会被拒绝',
        });

        expect(await TaskService.done(pending.id)).toBeNull();
        expect(await TaskService.fail(pending.id, '不应写入')).toBeNull();

        await TaskService.start(pending.id);
        const done = await TaskService.done(pending.id, '执行完成');
        expect(done?.status).toBe('done');
        expect(await TaskService.fail(pending.id, '迟到的失败回调')).toBeNull();
        expect(await TaskService.cancel(pending.id)).toBeNull();

        const current = await TaskService.getById(pending.id);
        expect(current?.status).toBe('done');
        expect(current?.resultLog).toBe('执行完成');
    });

    test('maxRetries 表示首次执行之外允许的重试次数', async () => {
        const task = await TaskService.add({
            name: '重试次数测试',
            agent: 'test-agent',
            prompt: '允许额外重试一次',
            maxRetries: 1,
        });

        await TaskService.start(task.id);
        const firstFailure = await TaskService.fail(task.id, '第一次失败', {}, { retryAfterMs: Date.now() - 1 });
        expect(firstFailure?.status).toBe('failed');
        expect(firstFailure?.retryCount).toBe(1);

        expect(await TaskService.start(task.id)).not.toBeNull();
        const secondFailure = await TaskService.fail(task.id, '重试后仍失败');
        expect(secondFailure?.status).toBe('dead_letter');
        expect(secondFailure?.retryCount).toBe(2);
    });

    test('手动重试会重置自动重试预算', async () => {
        const task = await TaskService.add({
            name: '手动恢复测试',
            agent: 'test-agent',
            prompt: '人工确认后重新执行',
            maxRetries: 0,
        });

        await TaskService.start(task.id);
        const dead = await TaskService.fail(task.id, '首次执行失败');
        expect(dead?.status).toBe('dead_letter');

        const retried = await TaskService.retry(task.id);
        expect(retried?.status).toBe('pending');
        expect(retried?.retryCount).toBe(0);
    });

    test('delayed 模板成功生成一次任务后自动禁用', async () => {
        const template = await TaskTemplateService.create({
            name: '一次性提醒',
            agent: 'test-agent',
            prompt: '只执行一次',
            scheduleType: 'delayed',
            runAt: Date.now() - 1,
        });

        const first = await cloneTaskFromTemplate(template.id);
        expect(first).not.toBeNull();
        await TaskService.start(first!.id);
        await TaskService.done(first!.id);

        expect(await cloneTaskFromTemplate(template.id)).toBeNull();
        const current = await TaskTemplateService.getById(template.id);
        expect(current?.enabled).toBe(false);
        expect(current?.nextRunAt).toBeNull();
    });

    test('删除任务会同时删除关联执行记录', async () => {
        const task = await TaskService.add({
            name: '级联删除测试',
            agent: 'test-agent',
            prompt: '删除后不能残留运行记录',
        });
        await TaskService.start(task.id);
        const run = await TaskRunService.create({ taskId: task.id });
        await TaskRunService.done(run.id, '执行完成');
        await TaskService.done(task.id, '执行完成');

        expect(await TaskService.delete(task.id)).toBe(true);
        expect(await TaskRunService.getById(run.id)).toBeNull();
    });
});
