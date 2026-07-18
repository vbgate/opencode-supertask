import { describe, test, expect, beforeEach } from 'bun:test';
import { setupTestDb } from './helpers/mock-db';
import { TaskService } from '../src/core/services/task.service';
import { TaskRunService } from '../src/core/services/task-run.service';
import { TaskTemplateService } from '../src/core/services/task-template.service';

describe('边界条件测试', () => {
    beforeEach(() => {
        setupTestDb();
    });

    describe('TaskService 边界', () => {
        test('拒绝将尚未 start 的任务直接标记为 done', async () => {
            const task = await TaskService.add({ name: 'T', agent: 'a', prompt: 'p' });
            const result = await TaskService.done(task.id);
            expect(result).toBeNull();
            expect((await TaskService.getById(task.id))!.status).toBe('pending');
        });

        test('拒绝取消一个已 done 的任务', async () => {
            const task = await TaskService.add({ name: 'T', agent: 'a', prompt: 'p' });
            await TaskService.start(task.id);
            await TaskService.done(task.id);
            const cancelled = await TaskService.cancel(task.id);
            expect(cancelled).toBeNull();
            expect((await TaskService.getById(task.id))!.status).toBe('done');
        });

        test('retry 已 cancelled 的任务返回 null', async () => {
            const task = await TaskService.add({ name: 'T', agent: 'a', prompt: 'p' });
            await TaskService.cancel(task.id);
            const result = await TaskService.retry(task.id);
            expect(result).toBeNull();
        });

        test('同一任务连续 fail 多次直到 dead_letter', async () => {
            const task = await TaskService.add({
                name: 'T',
                agent: 'a',
                prompt: 'p',
                maxRetries: 3,
            });

            for (let i = 1; i <= 4; i++) {
                await TaskService.start(task.id);
                await TaskService.fail(task.id, `第${i}次失败`);
            }

            const updated = await TaskService.getById(task.id);
            expect(updated!.status).toBe('dead_letter');
            expect(updated!.retryCount).toBe(4);
        });

        test('deleteOlderThan 只删除终态任务', async () => {
            const t1 = await TaskService.add({ name: 'Done', agent: 'a', prompt: 'p' });
            await TaskService.start(t1.id);
            await TaskService.done(t1.id);

            const t2 = await TaskService.add({ name: 'Pending', agent: 'a', prompt: 'p' });

            const count = await TaskService.deleteOlderThan(-1);
            expect(count).toBe(1);

            const found = await TaskService.getById(t2.id);
            expect(found).not.toBeNull();
        });

        test('deleteOlderThan 保留仍被可执行任务依赖的前置任务', async () => {
            const prerequisite = await TaskService.add({ name: '旧前置任务', agent: 'a', prompt: 'p' });
            await TaskService.start(prerequisite.id);
            await TaskService.done(prerequisite.id);
            const dependent = await TaskService.add({
                name: '待执行依赖任务',
                agent: 'a',
                prompt: 'p',
                dependsOn: prerequisite.id,
            });

            expect(await TaskService.deleteOlderThan(-1)).toBe(0);
            expect(await TaskService.getById(prerequisite.id)).not.toBeNull();
            expect(await TaskService.getById(dependent.id)).not.toBeNull();
        });

        test('stats 按 batchId 过滤', async () => {
            await TaskService.add({ name: 'T1', agent: 'a', prompt: 'p', batchId: 'b1' });
            await TaskService.add({ name: 'T2', agent: 'a', prompt: 'p', batchId: 'b2' });

            const stats = await TaskService.stats({ batchId: 'b1' });
            expect(stats.total).toBe(1);
        });

        test('stats 按 cwd 过滤', async () => {
            await TaskService.add({ name: 'T1', agent: 'a', prompt: 'p', cwd: process.cwd() });
            await TaskService.add({ name: 'T2', agent: 'a', prompt: 'p', cwd: '/tmp' });

            const stats = await TaskService.stats({ cwd: process.cwd() });
            expect(stats.total).toBe(1);
        });

        test('next urgency 高的任务优先于 importance 高的任务', async () => {
            await TaskService.add({
                name: '高importance低urgency',
                agent: 'a',
                prompt: 'p',
                importance: 5,
                urgency: 1,
            });
            const t2 = await TaskService.add({
                name: '低importance高urgency',
                agent: 'a',
                prompt: 'p',
                importance: 1,
                urgency: 5,
            });

            const next = await TaskService.next();
            expect(next!.id).toBe(t2.id);
        });

        test('add 拒绝 dependsOn 指向不存在任务', async () => {
            await expect(TaskService.add({
                name: '悬空依赖', agent: 'a', prompt: 'p', dependsOn: 99999,
            })).rejects.toThrow('不存在');
        });
    });

    describe('TaskRunService 边界', () => {
        test('同一任务多个并行 run', async () => {
            const task = await TaskService.add({ name: 'T', agent: 'a', prompt: 'p' });
            const r1 = await TaskRunService.create({ taskId: task.id, status: 'running' });
            const r2 = await TaskRunService.create({ taskId: task.id, status: 'running' });

            const runningRuns = await TaskRunService.getAllRunningRuns();
            expect(runningRuns.length).toBe(2);
            expect(runningRuns.map((r) => r.id)).toContain(r1.id);
            expect(runningRuns.map((r) => r.id)).toContain(r2.id);
        });

        test('getStaleRuns 返回正确的重试信息', async () => {
            const task = await TaskService.add({ name: 'T', agent: 'a', prompt: 'p', maxRetries: 5 });
            await TaskService.start(task.id);
            await TaskRunService.create({ taskId: task.id, status: 'running' });

            const stale = await TaskRunService.getStaleRuns(-100000);
            expect(stale.length).toBe(1);
            expect(stale[0].taskRetryCount).toBe(0);
            expect(stale[0].taskMaxRetries).toBe(5);
        });
    });

    describe('TaskTemplateService 边界', () => {
        test('create cron 模板自动计算 nextRunAt', async () => {
            const tmpl = await TaskTemplateService.create({
                name: 'Cron模板',
                agent: 'a',
                prompt: 'p',
                scheduleType: 'cron',
                cronExpr: '0 9 * * *',
            });
            expect(tmpl.nextRunAt).not.toBeNull();
            expect(tmpl.nextRunAt!).toBeGreaterThan(Date.now() - 1000);
        });

        test('create recurring 模板自动计算 nextRunAt', async () => {
            const tmpl = await TaskTemplateService.create({
                name: 'Recurring模板',
                agent: 'a',
                prompt: 'p',
                scheduleType: 'recurring',
                intervalMs: 3600000,
            });
            expect(tmpl.nextRunAt).not.toBeNull();
        });

        test('create delayed 模板使用指定 runAt', async () => {
            const runAt = Date.now() + 86400000;
            const tmpl = await TaskTemplateService.create({
                name: 'Delayed模板',
                agent: 'a',
                prompt: 'p',
                scheduleType: 'delayed',
                runAt,
            });
            expect(tmpl.nextRunAt).toBe(runAt);
        });

        test('delete 不存在的模板返回 false', async () => {
            const result = await TaskTemplateService.delete(99999);
            expect(result).toBe(false);
        });

        test('enable/disable 不存在的模板返回 null', async () => {
            expect(await TaskTemplateService.enable(99999)).toBeNull();
            expect(await TaskTemplateService.disable(99999)).toBeNull();
        });

        test('getById 不存在返回 null', async () => {
            expect(await TaskTemplateService.getById(99999)).toBeNull();
        });

        test('calculateNextRunAt 无效 cron 返回 null', () => {
            const result = TaskTemplateService.calculateNextRunAt('cron', {
                cronExpr: 'invalid-cron',
                intervalMs: null,
                runAt: null,
            });
            expect(result).toBeNull();
        });

        test('calculateNextRunAt recurring 无 intervalMs 返回 null', () => {
            const result = TaskTemplateService.calculateNextRunAt('recurring', {
                cronExpr: null,
                intervalMs: null,
                runAt: null,
            });
            expect(result).toBeNull();
        });

        test('calculateNextRunAt delayed 无 runAt 返回 null', () => {
            const result = TaskTemplateService.calculateNextRunAt('delayed', {
                cronExpr: null,
                intervalMs: null,
                runAt: null,
            });
            expect(result).toBeNull();
        });

        test('calculateNextRunAt 未知类型返回 null', () => {
            const result = TaskTemplateService.calculateNextRunAt('unknown' as never, {
                cronExpr: null,
                intervalMs: null,
                runAt: null,
            });
            expect(result).toBeNull();
        });
    });

    describe('完整任务流程集成', () => {
        test('模板 → 克隆 → 执行 → 完成', async () => {
            const tmpl = await TaskTemplateService.create({
                name: '流程测试',
                agent: 'worker',
                prompt: '执行任务',
                scheduleType: 'recurring',
                intervalMs: 3600000,
                maxRetries: 2,
            });

            const { cloneTaskFromTemplate } = await import('../src/gateway/scheduler/job-templates');
            const task = await cloneTaskFromTemplate(tmpl.id);
            expect(task).not.toBeNull();

            await TaskService.start(task!.id);
            const run = await TaskRunService.create({
                taskId: task!.id,
                status: 'running',
                model: 'glm-4',
            });

            await TaskRunService.done(run.id, '执行成功');
            await TaskService.done(task!.id, '任务完成');

            const final = await TaskService.getById(task!.id);
            expect(final!.status).toBe('done');

            const tmplAfter = await TaskTemplateService.getById(tmpl.id);
            expect(tmplAfter!.lastRunAt).not.toBeNull();
            expect(tmplAfter!.nextRunAt).not.toBeNull();
        });

        test('多任务优先级调度', async () => {
            const tasks = [];
            for (let i = 5; i >= 1; i--) {
                tasks.push(await TaskService.add({
                    name: `优先级${i}`,
                    agent: 'a',
                    prompt: `importance=${i}`,
                    importance: i,
                    urgency: i,
                }));
            }

            const order: number[] = [];
            for (let i = 0; i < 5; i++) {
                const next = await TaskService.next();
                expect(next).not.toBeNull();
                order.push(next!.importance!);
                await TaskService.start(next!.id);
                await TaskService.done(next!.id);
            }

            for (let i = 0; i < order.length - 1; i++) {
                expect(order[i]).toBeGreaterThanOrEqual(order[i + 1]!);
            }
        });

        test('batch 内任务逐个执行', async () => {
            const batchId = 'sequential-batch';
            const t1 = await TaskService.add({
                name: '批次任务1',
                agent: 'a',
                prompt: 'p',
                batchId,
            });
            const t2 = await TaskService.add({
                name: '批次任务2',
                agent: 'a',
                prompt: 'p',
                batchId,
            });

            const next1 = await TaskService.next();
            expect(next1!.id).toBe(t1.id);
            await TaskService.start(t1.id);

            const next2 = await TaskService.next({ excludedBatchIds: [batchId] });
            expect(next2).toBeNull();

            await TaskService.done(t1.id);

            const next3 = await TaskService.next();
            expect(next3!.id).toBe(t2.id);
        });
    });
});
