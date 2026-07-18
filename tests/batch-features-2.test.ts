import { describe, test, expect, beforeEach } from 'bun:test';
import { setupTestDb } from './helpers/mock-db';
import { TaskService } from '../src/core/services/task.service';

describe('批次功能测试 #2', () => {
    beforeEach(() => {
        setupTestDb();
    });

    describe('next() 排除多批次时 null batchId 任务不受影响', () => {
        test('排除多个批次时，无 batchId 的任务仍可被获取', async () => {
            const independentTask = await TaskService.add({
                name: '独立任务',
                agent: 'a',
                prompt: 'p',
            });
            await TaskService.add({
                name: '批次A',
                agent: 'a',
                prompt: 'p',
                batchId: 'batch-a',
            });
            await TaskService.add({
                name: '批次B',
                agent: 'a',
                prompt: 'p',
                batchId: 'batch-b',
            });
            await TaskService.add({
                name: '批次C',
                agent: 'a',
                prompt: 'p',
                batchId: 'batch-c',
            });

            const next = await TaskService.next({
                excludedBatchIds: ['batch-a', 'batch-b', 'batch-c'],
            });
            expect(next).not.toBeNull();
            expect(next!.id).toBe(independentTask.id);
            expect(next!.batchId).toBeNull();
        });

        test('排除所有批次后，只剩无 batchId 的任务可选', async () => {
            const t1 = await TaskService.add({ name: '独立1', agent: 'a', prompt: 'p' });
            const t2 = await TaskService.add({ name: '独立2', agent: 'a', prompt: 'p' });
            await TaskService.add({ name: '批次A', agent: 'a', prompt: 'p', batchId: 'batch-a' });

            const next1 = await TaskService.next({ excludedBatchIds: ['batch-a'] });
            expect(next1!.id).toBe(t1.id);

            await TaskService.start(t1.id);
            await TaskService.done(t1.id);

            const next2 = await TaskService.next({ excludedBatchIds: ['batch-a'] });
            expect(next2!.id).toBe(t2.id);
        });

        test('excludedBatchIds 为空数组时不产生过滤效果', async () => {
            const batchTask = await TaskService.add({
                name: '批次任务',
                agent: 'a',
                prompt: 'p',
                batchId: 'batch-x',
                importance: 5,
                urgency: 5,
            });
            await TaskService.add({
                name: '独立任务',
                agent: 'a',
                prompt: 'p',
                importance: 1,
                urgency: 1,
            });

            const next = await TaskService.next({ excludedBatchIds: [] });
            expect(next).not.toBeNull();
            expect(next!.id).toBe(batchTask.id);
        });
    });

    describe('retryBatch 边界场景', () => {
        test('retryBatch 同时重试 failed 和 dead_letter 状态', async () => {
            const t1 = await TaskService.add({
                name: '任务一',
                agent: 'a',
                prompt: 'p',
                batchId: 'batch-retry',
                maxRetries: 3,
            });
            const t2 = await TaskService.add({
                name: '任务二',
                agent: 'a',
                prompt: 'p',
                batchId: 'batch-retry',
                maxRetries: 0,
            });

            await TaskService.start(t1.id);
            await TaskService.fail(t1.id, '首次失败');
            expect((await TaskService.getById(t1.id))!.status).toBe('failed');

            await TaskService.start(t2.id);
            await TaskService.fail(t2.id, '达到上限');
            expect((await TaskService.getById(t2.id))!.status).toBe('dead_letter');

            const count = await TaskService.retryBatch('batch-retry');
            expect(count).toBe(2);

            const r1 = await TaskService.getById(t1.id);
            const r2 = await TaskService.getById(t2.id);
            expect(r1!.status).toBe('pending');
            expect(r2!.status).toBe('pending');
        });

        test('retryBatch 不影响 pending/running/done/cancelled 状态的任务', async () => {
            const pending = await TaskService.add({
                name: '待执行',
                agent: 'a',
                prompt: 'p',
                batchId: 'batch-mixed',
            });
            const running = await TaskService.add({
                name: '执行中',
                agent: 'a',
                prompt: 'p',
                batchId: 'batch-mixed',
            });
            const done = await TaskService.add({
                name: '已完成',
                agent: 'a',
                prompt: 'p',
                batchId: 'batch-mixed',
            });
            const cancelled = await TaskService.add({
                name: '已取消',
                agent: 'a',
                prompt: 'p',
                batchId: 'batch-mixed',
            });

            await TaskService.start(running.id);
            await TaskService.start(done.id);
            await TaskService.done(done.id);
            await TaskService.cancel(cancelled.id);

            const count = await TaskService.retryBatch('batch-mixed');
            expect(count).toBe(0);

            expect((await TaskService.getById(pending.id))!.status).toBe('pending');
            expect((await TaskService.getById(running.id))!.status).toBe('running');
            expect((await TaskService.getById(done.id))!.status).toBe('done');
            expect((await TaskService.getById(cancelled.id))!.status).toBe('cancelled');
        });

        test('retryBatch 带 cwd 过滤', async () => {
            const t1 = await TaskService.add({
                name: '项目A任务',
                agent: 'a',
                prompt: 'p',
                batchId: 'batch-cwd',
                cwd: process.cwd(),
                maxRetries: 3,
            });
            const t2 = await TaskService.add({
                name: '项目B任务',
                agent: 'a',
                prompt: 'p',
                batchId: 'batch-cwd',
                cwd: '/tmp',
                maxRetries: 3,
            });

            await TaskService.start(t1.id);
            await TaskService.fail(t1.id, '失败');
            await TaskService.start(t2.id);
            await TaskService.fail(t2.id, '失败');

            const countA = await TaskService.retryBatch('batch-cwd', { cwd: process.cwd() });
            expect(countA).toBe(1);

            const r1 = await TaskService.getById(t1.id);
            const r2 = await TaskService.getById(t2.id);
            expect(r1!.status).toBe('pending');
            expect(r2!.status).toBe('failed');
        });

        test('retryBatch 重试后重置 retryCount（恢复完整自动重试预算）', async () => {
            const task = await TaskService.add({
                name: '重试计数验证',
                agent: 'a',
                prompt: 'p',
                batchId: 'batch-count',
                maxRetries: 5,
            });

            await TaskService.start(task.id);
            await TaskService.fail(task.id, '失败一次');
            expect((await TaskService.getById(task.id))!.retryCount).toBe(1);

            await TaskService.start(task.id);
            await TaskService.fail(task.id, '失败两次');
            expect((await TaskService.getById(task.id))!.retryCount).toBe(2);

            await TaskService.retryBatch('batch-count');

            const found = await TaskService.getById(task.id);
            expect(found!.status).toBe('pending');
            expect(found!.retryCount).toBe(0);
        });
    });

    describe('stats 按 batchId 筛选', () => {
        test('stats 仅返回指定批次的数据', async () => {
            for (let i = 0; i < 3; i++) {
                const t = await TaskService.add({
                    name: `批次A任务${i}`,
                    agent: 'a',
                    prompt: 'p',
                    batchId: 'stats-batch-a',
                });
                await TaskService.start(t.id);
                await TaskService.done(t.id);
            }

            const failed = await TaskService.add({
                name: '批次B失败任务',
                agent: 'a',
                prompt: 'p',
                batchId: 'stats-batch-b',
                maxRetries: 3,
            });
            await TaskService.start(failed.id);
            await TaskService.fail(failed.id, '失败');

            const statsA = await TaskService.stats({ batchId: 'stats-batch-a' });
            expect(statsA.total).toBe(3);
            expect(statsA.done).toBe(3);
            expect(statsA.failed).toBe(0);
            expect(statsA.pending).toBe(0);

            const statsB = await TaskService.stats({ batchId: 'stats-batch-b' });
            expect(statsB.total).toBe(1);
            expect(statsB.failed).toBe(1);
        });

        test('stats 对不存在的批次返回全零', async () => {
            const stats = await TaskService.stats({ batchId: 'nonexistent' });
            expect(stats.total).toBe(0);
        });

        test('stats 同时按 batchId 和 cwd 过滤', async () => {
            const t1 = await TaskService.add({
                name: '项目A批次X',
                agent: 'a',
                prompt: 'p',
                batchId: 'batch-x',
                cwd: process.cwd(),
            });
            const t2 = await TaskService.add({
                name: '项目B批次X',
                agent: 'a',
                prompt: 'p',
                batchId: 'batch-x',
                cwd: '/tmp',
            });

            await TaskService.start(t1.id);
            await TaskService.done(t1.id);

            const stats = await TaskService.stats({ batchId: 'batch-x', cwd: process.cwd() });
            expect(stats.total).toBe(1);
            expect(stats.done).toBe(1);
        });
    });

    describe('批次内含依赖任务', () => {
        test('批次内依赖任务的前置任务不在该批次时，依赖完成后仍可被 next 取到', async () => {
            const dep = await TaskService.add({
                name: '前置任务（无批次）',
                agent: 'a',
                prompt: 'p',
            });
            const dependent = await TaskService.add({
                name: '依赖任务（有批次）',
                agent: 'a',
                prompt: 'p',
                dependsOn: dep.id,
                batchId: 'batch-dep',
            });

            const nextBefore = await TaskService.next();
            expect(nextBefore).not.toBeNull();
            expect(nextBefore!.id).toBe(dep.id);

            await TaskService.start(dep.id);
            await TaskService.done(dep.id);

            const nextAfter = await TaskService.next();
            expect(nextAfter).not.toBeNull();
            expect(nextAfter!.id).toBe(dependent.id);
            expect(nextAfter!.batchId).toBe('batch-dep');
        });

        test('批次内依赖任务在排除该批次时不可被获取', async () => {
            const dep = await TaskService.add({
                name: '前置',
                agent: 'a',
                prompt: 'p',
            });
            await TaskService.add({
                name: '依赖',
                agent: 'a',
                prompt: 'p',
                dependsOn: dep.id,
                batchId: 'batch-excluded',
            });

            await TaskService.start(dep.id);
            await TaskService.done(dep.id);

            const next = await TaskService.next({ excludedBatchIds: ['batch-excluded'] });
            expect(next).toBeNull();
        });

        test('批次内多级依赖链（A→B→C），全部在同一批次', async () => {
            const a = await TaskService.add({
                name: '步骤A',
                agent: 'a',
                prompt: 'p',
                batchId: 'chain',
            });
            const b = await TaskService.add({
                name: '步骤B',
                agent: 'a',
                prompt: 'p',
                dependsOn: a.id,
                batchId: 'chain',
            });
            const c = await TaskService.add({
                name: '步骤C',
                agent: 'a',
                prompt: 'p',
                dependsOn: b.id,
                batchId: 'chain',
            });

            const next1 = await TaskService.next();
            expect(next1!.id).toBe(a.id);

            await TaskService.start(a.id);
            await TaskService.done(a.id);

            const next2 = await TaskService.next();
            expect(next2!.id).toBe(b.id);

            await TaskService.start(b.id);
            await TaskService.done(b.id);

            const next3 = await TaskService.next();
            expect(next3!.id).toBe(c.id);
        });
    });

    describe('批次与优先级交互', () => {
        test('不同批次但不同优先级，next 返回优先级最高的', async () => {
            const low = await TaskService.add({
                name: '批次A低优先级',
                agent: 'a',
                prompt: 'p',
                batchId: 'batch-prio-a',
                importance: 1,
                urgency: 1,
            });
            const high = await TaskService.add({
                name: '批次B高优先级',
                agent: 'a',
                prompt: 'p',
                batchId: 'batch-prio-b',
                importance: 5,
                urgency: 5,
            });

            const next = await TaskService.next();
            expect(next!.id).toBe(high.id);
            expect(next!.batchId).toBe('batch-prio-b');
        });

        test('高优先级批次被排除时，返回次高优先级的其他批次任务', async () => {
            const low = await TaskService.add({
                name: '批次A',
                agent: 'a',
                prompt: 'p',
                batchId: 'batch-ex-high',
                importance: 5,
                urgency: 5,
            });
            const high = await TaskService.add({
                name: '批次B',
                agent: 'a',
                prompt: 'p',
                batchId: 'batch-ex-low',
                importance: 3,
                urgency: 3,
            });

            const next = await TaskService.next({ excludedBatchIds: ['batch-ex-high'] });
            expect(next!.id).toBe(high.id);
            expect(next!.batchId).toBe('batch-ex-low');
        });

        test('同批次内多个 pending 任务按优先级排序', async () => {
            const low = await TaskService.add({
                name: '低',
                agent: 'a',
                prompt: 'p',
                batchId: 'same-batch',
                importance: 1,
                urgency: 1,
            });
            const high = await TaskService.add({
                name: '高',
                agent: 'a',
                prompt: 'p',
                batchId: 'same-batch',
                importance: 5,
                urgency: 5,
            });

            const next = await TaskService.next();
            expect(next!.id).toBe(high.id);
        });
    });

    describe('批次任务的生命周期状态转换', () => {
        test('批次任务完成生命周期：pending → running → done', async () => {
            const task = await TaskService.add({
                name: '批次生命周期',
                agent: 'a',
                prompt: 'p',
                batchId: 'lifecycle-batch',
            });

            expect((await TaskService.getById(task.id))!.status).toBe('pending');

            const started = await TaskService.start(task.id);
            expect(started!.status).toBe('running');
            expect(started!.batchId).toBe('lifecycle-batch');

            const finished = await TaskService.done(task.id, '完成');
            expect(finished!.status).toBe('done');
            expect(finished!.batchId).toBe('lifecycle-batch');
            expect(finished!.resultLog).toBe('完成');
        });

        test('批次任务失败生命周期：pending → running → failed → retryBatch → pending → running → done', async () => {
            const task = await TaskService.add({
                name: '失败恢复测试',
                agent: 'a',
                prompt: 'p',
                batchId: 'lifecycle-fail',
                maxRetries: 3,
            });

            await TaskService.start(task.id);
            await TaskService.fail(task.id, '第一次失败');
            expect((await TaskService.getById(task.id))!.status).toBe('failed');
            expect((await TaskService.getById(task.id))!.retryCount).toBe(1);

            await TaskService.retryBatch('lifecycle-fail');
            expect((await TaskService.getById(task.id))!.status).toBe('pending');

            await TaskService.start(task.id);
            await TaskService.done(task.id, '第二次成功');
            expect((await TaskService.getById(task.id))!.status).toBe('done');
        });

        test('批次任务被取消后不能被 retryBatch 恢复', async () => {
            const task = await TaskService.add({
                name: '已取消批次任务',
                agent: 'a',
                prompt: 'p',
                batchId: 'cancelled-batch',
            });

            await TaskService.cancel(task.id);
            expect((await TaskService.getById(task.id))!.status).toBe('cancelled');

            const count = await TaskService.retryBatch('cancelled-batch');
            expect(count).toBe(0);
            expect((await TaskService.getById(task.id))!.status).toBe('cancelled');
        });

        test('批次任务达到 dead_letter 后被 retryBatch 恢复', async () => {
            const task = await TaskService.add({
                name: '死信恢复',
                agent: 'a',
                prompt: 'p',
                batchId: 'dead-batch',
                maxRetries: 0,
            });

            await TaskService.start(task.id);
            await TaskService.fail(task.id, '立即死信');
            expect((await TaskService.getById(task.id))!.status).toBe('dead_letter');

            await TaskService.retryBatch('dead-batch');
            expect((await TaskService.getById(task.id))!.status).toBe('pending');

            await TaskService.start(task.id);
            await TaskService.done(task.id, '恢复成功');
            expect((await TaskService.getById(task.id))!.status).toBe('done');
        });
    });

    describe('deleteOlderThan 与批次', () => {
        test('deleteOlderThan 删除过期完成的批次任务后，批次统计归零', async () => {
            const { getDb } = await import('../src/core/db');
            const sqliteDb = getDb();

            const t1 = await TaskService.add({
                name: '批次任务A',
                agent: 'a',
                prompt: 'p',
                batchId: 'old-batch',
            });
            const t2 = await TaskService.add({
                name: '批次任务B',
                agent: 'a',
                prompt: 'p',
                batchId: 'old-batch',
            });

            await TaskService.start(t1.id);
            await TaskService.done(t1.id);
            await TaskService.start(t2.id);
            await TaskService.done(t2.id);

            const statsBefore = await TaskService.stats({ batchId: 'old-batch' });
            expect(statsBefore.done).toBe(2);

            const { tasks } = await import('../src/core/db/schema');
            const { sql } = await import('drizzle-orm');
            await sqliteDb
                .update(tasks)
                .set({ finishedAt: new Date(1000) })
                .where(sql`${tasks.id} IN (${t1.id}, ${t2.id})`);

            const deleted = await TaskService.deleteOlderThan(-1);
            expect(deleted).toBe(2);

            const statsAfter = await TaskService.stats({ batchId: 'old-batch' });
            expect(statsAfter.total).toBe(0);
        });
    });
});
