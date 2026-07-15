import { describe, test, expect, beforeEach } from 'bun:test';
import { setupTestDb } from './helpers/mock-db';
import { TaskService } from '../src/core/services/task.service';

describe('TaskService', () => {
    beforeEach(() => {
        setupTestDb();
    });

    describe('add', () => {
        test('创建基本任务', async () => {
            const task = await TaskService.add({
                name: '翻译文档',
                agent: 'translator',
                prompt: '翻译 README.md',
            });
            expect(task.id).toBeGreaterThan(0);
            expect(task.name).toBe('翻译文档');
            expect(task.agent).toBe('translator');
            expect(task.prompt).toBe('翻译 README.md');
            expect(task.status).toBe('pending');
            expect(task.importance).toBe(3);
            expect(task.urgency).toBe(3);
            expect(task.retryCount).toBe(0);
            expect(task.maxRetries).toBe(3);
        });

        test('创建带完整参数的任务', async () => {
            const task = await TaskService.add({
                name: '紧急审查',
                agent: 'reviewer',
                prompt: '审查 PR #42',
                model: 'gpt-4',
                category: 'review',
                importance: 5,
                urgency: 5,
                batchId: 'batch-001',
                dependsOn: undefined,
                cwd: '/project',
                maxRetries: 5,
            });
            expect(task.category).toBe('review');
            expect(task.importance).toBe(5);
            expect(task.urgency).toBe(5);
            expect(task.batchId).toBe('batch-001');
            expect(task.model).toBe('gpt-4');
            expect(task.cwd).toBe('/project');
            expect(task.maxRetries).toBe(5);
        });
    });

    describe('getById', () => {
        test('根据 ID 获取存在的任务', async () => {
            const created = await TaskService.add({
                name: '查询测试',
                agent: 'agent-a',
                prompt: '查询',
            });
            const found = await TaskService.getById(created.id);
            expect(found).not.toBeNull();
            expect(found!.id).toBe(created.id);
            expect(found!.name).toBe('查询测试');
        });

        test('获取不存在的任务返回 null', async () => {
            const found = await TaskService.getById(99999);
            expect(found).toBeNull();
        });

        test('按 cwd 过滤', async () => {
            const t1 = await TaskService.add({
                name: '项目A任务',
                agent: 'agent-a',
                prompt: '测试',
                cwd: '/project-a',
            });
            await TaskService.add({
                name: '项目B任务',
                agent: 'agent-b',
                prompt: '测试',
                cwd: '/project-b',
            });

            const found = await TaskService.getById(t1.id, { cwd: '/project-a' });
            expect(found).not.toBeNull();

            const notFound = await TaskService.getById(t1.id, { cwd: '/project-b' });
            expect(notFound).toBeNull();
        });
    });

    describe('next', () => {
        test('返回最高优先级的 pending 任务', async () => {
            await TaskService.add({
                name: '低优先级',
                agent: 'agent-a',
                prompt: '低',
                importance: 1,
                urgency: 1,
            });
            await TaskService.add({
                name: '高优先级',
                agent: 'agent-a',
                prompt: '高',
                importance: 5,
                urgency: 5,
            });
            await TaskService.add({
                name: '中优先级',
                agent: 'agent-a',
                prompt: '中',
                importance: 3,
                urgency: 3,
            });

            const next = await TaskService.next();
            expect(next).not.toBeNull();
            expect(next!.name).toBe('高优先级');
        });

        test('同优先级按创建时间排序（FIFO）', async () => {
            const first = await TaskService.add({
                name: '第一个',
                agent: 'agent-a',
                prompt: '一',
                importance: 3,
                urgency: 3,
            });
            await TaskService.add({
                name: '第二个',
                agent: 'agent-a',
                prompt: '二',
                importance: 3,
                urgency: 3,
            });

            const next = await TaskService.next();
            expect(next!.id).toBe(first.id);
        });

        test('没有 pending 任务时返回 null', async () => {
            const next = await TaskService.next();
            expect(next).toBeNull();
        });

        test('跳过 running/done/cancelled 状态的任务', async () => {
            const t1 = await TaskService.add({ name: 'T1', agent: 'a', prompt: 'p' });
            await TaskService.start(t1.id);

            const t2 = await TaskService.add({ name: 'T2', agent: 'a', prompt: 'p' });
            await TaskService.start(t2.id);
            await TaskService.done(t2.id);

            const t3 = await TaskService.add({ name: 'T3', agent: 'a', prompt: 'p' });
            await TaskService.cancel(t3.id);

            const next = await TaskService.next();
            expect(next).toBeNull();
        });

        test('按 cwd 过滤', async () => {
            await TaskService.add({
                name: '项目A',
                agent: 'a',
                prompt: 'p',
                cwd: '/project-a',
            });
            const t2 = await TaskService.add({
                name: '项目B',
                agent: 'a',
                prompt: 'p',
                cwd: '/project-b',
            });

            const next = await TaskService.next({ cwd: '/project-b' });
            expect(next).not.toBeNull();
            expect(next!.id).toBe(t2.id);
        });

        test('排除指定 batchId', async () => {
            await TaskService.add({
                name: '批次任务',
                agent: 'a',
                prompt: 'p',
                batchId: 'batch-1',
            });
            const t2 = await TaskService.add({
                name: '独立任务',
                agent: 'a',
                prompt: 'p',
            });

            const next = await TaskService.next({ excludedBatchIds: ['batch-1'] });
            expect(next).not.toBeNull();
            expect(next!.id).toBe(t2.id);
        });

        test('retryAfter 未到期时不返回 failed 任务', async () => {
            const task = await TaskService.add({
                name: '延迟重试任务',
                agent: 'a',
                prompt: 'p',
            });
            await TaskService.start(task.id);
            await TaskService.fail(task.id, '失败', {}, { retryAfterMs: Date.now() + 3600000 });

            const next = await TaskService.next();
            expect(next).toBeNull();
        });

        test('retryAfter 已到期时返回 failed 任务', async () => {
            const task = await TaskService.add({
                name: '到期重试任务',
                agent: 'a',
                prompt: 'p',
            });
            await TaskService.start(task.id);
            await TaskService.fail(task.id, '失败', {}, { retryAfterMs: Date.now() - 1000 });

            const next = await TaskService.next();
            expect(next).not.toBeNull();
            expect(next!.id).toBe(task.id);
        });

        test('dependsOn 未完成时返回无依赖的任务，跳过有依赖的', async () => {
            const dep = await TaskService.add({
                name: '前置任务',
                agent: 'a',
                prompt: 'p',
            });
            await TaskService.add({
                name: '依赖任务',
                agent: 'a',
                prompt: 'p',
                dependsOn: dep.id,
            });

            const next = await TaskService.next();
            expect(next).not.toBeNull();
            expect(next!.id).toBe(dep.id);
        });

        test('dependsOn 完成后返回依赖任务', async () => {
            const dep = await TaskService.add({
                name: '前置任务',
                agent: 'a',
                prompt: 'p',
            });
            const dependent = await TaskService.add({
                name: '依赖任务',
                agent: 'a',
                prompt: 'p',
                dependsOn: dep.id,
            });

            await TaskService.start(dep.id);
            await TaskService.done(dep.id);

            const next = await TaskService.next();
            expect(next).not.toBeNull();
            expect(next!.id).toBe(dependent.id);
        });

        test('retryCount > maxRetries 的 failed 任务不返回（已耗尽重试）', async () => {
            const task = await TaskService.add({
                name: '最终失败任务',
                agent: 'a',
                prompt: 'p',
                maxRetries: 0,
            });
            await TaskService.start(task.id);
            await TaskService.fail(task.id, '失败');

            expect(task.maxRetries).toBe(0);
            const next = await TaskService.next();
            expect(next).toBeNull();
        });
    });

    describe('start', () => {
        test('将 pending 任务标记为 running', async () => {
            const task = await TaskService.add({
                name: '启动测试',
                agent: 'a',
                prompt: 'p',
            });
            const started = await TaskService.start(task.id);
            expect(started).not.toBeNull();
            expect(started!.status).toBe('running');
            expect(started!.startedAt).not.toBeNull();
        });

        test('不能 start 已 done 的任务', async () => {
            const task = await TaskService.add({ name: 'T', agent: 'a', prompt: 'p' });
            await TaskService.start(task.id);
            await TaskService.done(task.id);

            const result = await TaskService.start(task.id);
            expect(result).toBeNull();
        });

        test('不能 start 已 cancelled 的任务', async () => {
            const task = await TaskService.add({ name: 'T', agent: 'a', prompt: 'p' });
            await TaskService.cancel(task.id);

            const result = await TaskService.start(task.id);
            expect(result).toBeNull();
        });

        test('可以 start failed 但未超重试次数的任务', async () => {
            const task = await TaskService.add({
                name: 'T',
                agent: 'a',
                prompt: 'p',
                maxRetries: 3,
            });
            await TaskService.start(task.id);
            await TaskService.fail(task.id, '首次失败');

            const restarted = await TaskService.start(task.id);
            expect(restarted).not.toBeNull();
            expect(restarted!.status).toBe('running');
        });
    });

    describe('done', () => {
        test('标记任务为 done 并记录日志', async () => {
            const task = await TaskService.add({ name: 'T', agent: 'a', prompt: 'p' });
            await TaskService.start(task.id);
            const finished = await TaskService.done(task.id, '执行完成');
            expect(finished).not.toBeNull();
            expect(finished!.status).toBe('done');
            expect(finished!.finishedAt).not.toBeNull();
            expect(finished!.resultLog).toBe('执行完成');
        });

        test('done 后清除 retryAfter', async () => {
            const task = await TaskService.add({ name: 'T', agent: 'a', prompt: 'p' });
            await TaskService.start(task.id);
            await TaskService.fail(task.id, '失败', {}, { retryAfterMs: Date.now() + 60000 });

            await TaskService.retry(task.id);
            await TaskService.start(task.id);
            const finished = await TaskService.done(task.id);
            expect(finished!.retryAfter).toBeNull();
        });
    });

    describe('fail', () => {
        test('第一次失败 → status=failed, retryCount=1', async () => {
            const task = await TaskService.add({
                name: 'T',
                agent: 'a',
                prompt: 'p',
                maxRetries: 3,
            });
            await TaskService.start(task.id);
            const failed = await TaskService.fail(task.id, '首次失败');
            expect(failed).not.toBeNull();
            expect(failed!.status).toBe('failed');
            expect(failed!.retryCount).toBe(1);
            expect(failed!.retryAfter).not.toBeNull();
        });

        test('耗尽最大重试次数后 → dead_letter', async () => {
            const task = await TaskService.add({
                name: 'T',
                agent: 'a',
                prompt: 'p',
                maxRetries: 1,
            });
            await TaskService.start(task.id);
            const first = await TaskService.fail(task.id, '首次失败', {}, { retryAfterMs: Date.now() - 1 });
            expect(first!.status).toBe('failed');
            await TaskService.start(task.id);
            const failed = await TaskService.fail(task.id, '重试后仍失败');
            expect(failed!.status).toBe('dead_letter');
            expect(failed!.retryAfter).toBeNull();
        });

        test('强制 setDeadLetter=true', async () => {
            const task = await TaskService.add({
                name: 'T',
                agent: 'a',
                prompt: 'p',
                maxRetries: 10,
            });
            await TaskService.start(task.id);
            const failed = await TaskService.fail(task.id, '强制死信', {}, { setDeadLetter: true });
            expect(failed!.status).toBe('dead_letter');
        });

        test('自定义 retryAfterMs', async () => {
            const task = await TaskService.add({
                name: 'T',
                agent: 'a',
                prompt: 'p',
                maxRetries: 3,
            });
            await TaskService.start(task.id);
            const customRetry = Date.now() + 120000;
            const failed = await TaskService.fail(task.id, '自定义延迟', {}, { retryAfterMs: customRetry });
            expect(failed!.retryAfter).toBe(customRetry);
        });

        test('对不存在任务返回 null', async () => {
            const result = await TaskService.fail(99999, '不存在');
            expect(result).toBeNull();
        });
    });

    describe('cancel', () => {
        test('取消 pending 任务', async () => {
            const task = await TaskService.add({ name: 'T', agent: 'a', prompt: 'p' });
            const cancelled = await TaskService.cancel(task.id);
            expect(cancelled).not.toBeNull();
            expect(cancelled!.status).toBe('cancelled');
        });

        test('取消 running 任务', async () => {
            const task = await TaskService.add({ name: 'T', agent: 'a', prompt: 'p' });
            await TaskService.start(task.id);
            const cancelled = await TaskService.cancel(task.id);
            expect(cancelled!.status).toBe('cancelled');
        });

        test('取消不存在任务返回 null', async () => {
            const result = await TaskService.cancel(99999);
            expect(result).toBeNull();
        });
    });

    describe('retry', () => {
        test('重试 failed 任务', async () => {
            const task = await TaskService.add({
                name: 'T',
                agent: 'a',
                prompt: 'p',
                maxRetries: 3,
            });
            await TaskService.start(task.id);
            await TaskService.fail(task.id, '失败');

            const retried = await TaskService.retry(task.id);
            expect(retried).not.toBeNull();
            expect(retried!.status).toBe('pending');
            expect(retried!.startedAt).toBeNull();
            expect(retried!.finishedAt).toBeNull();
            expect(retried!.retryAfter).toBeNull();
        });

        test('重试 dead_letter 任务', async () => {
            const task = await TaskService.add({
                name: 'T',
                agent: 'a',
                prompt: 'p',
                maxRetries: 1,
            });
            await TaskService.start(task.id);
            await TaskService.fail(task.id, '最终失败');

            const retried = await TaskService.retry(task.id);
            expect(retried).not.toBeNull();
            expect(retried!.status).toBe('pending');
        });

        test('不能重试 pending/running/done 任务', async () => {
            const task = await TaskService.add({ name: 'T', agent: 'a', prompt: 'p' });

            const r1 = await TaskService.retry(task.id);
            expect(r1).toBeNull();

            await TaskService.start(task.id);
            const r2 = await TaskService.retry(task.id);
            expect(r2).toBeNull();

            await TaskService.done(task.id);
            const r3 = await TaskService.retry(task.id);
            expect(r3).toBeNull();
        });
    });

    describe('retryBatch', () => {
        test('批量重试同一 batch 的 failed 任务', async () => {
            const t1 = await TaskService.add({
                name: 'T1',
                agent: 'a',
                prompt: 'p',
                batchId: 'batch-x',
                maxRetries: 3,
            });
            const t2 = await TaskService.add({
                name: 'T2',
                agent: 'a',
                prompt: 'p',
                batchId: 'batch-x',
                maxRetries: 3,
            });

            await TaskService.start(t1.id);
            await TaskService.fail(t1.id, '失败');
            await TaskService.start(t2.id);
            await TaskService.fail(t2.id, '失败');

            const count = await TaskService.retryBatch('batch-x');
            expect(count).toBe(2);

            const r1 = await TaskService.getById(t1.id);
            const r2 = await TaskService.getById(t2.id);
            expect(r1!.status).toBe('pending');
            expect(r2!.status).toBe('pending');
        });

        test('不影响其他 batch 的任务', async () => {
            const t1 = await TaskService.add({
                name: 'T1',
                agent: 'a',
                prompt: 'p',
                batchId: 'batch-a',
                maxRetries: 3,
            });
            const t2 = await TaskService.add({
                name: 'T2',
                agent: 'a',
                prompt: 'p',
                batchId: 'batch-b',
                maxRetries: 3,
            });

            await TaskService.start(t1.id);
            await TaskService.fail(t1.id, '失败');
            await TaskService.start(t2.id);
            await TaskService.fail(t2.id, '失败');

            await TaskService.retryBatch('batch-a');
            const r2 = await TaskService.getById(t2.id);
            expect(r2!.status).toBe('failed');
        });

        test('空 batch 返回 0', async () => {
            const count = await TaskService.retryBatch('nonexistent-batch');
            expect(count).toBe(0);
        });
    });

    describe('list', () => {
        test('列出所有任务', async () => {
            await TaskService.add({ name: 'T1', agent: 'a', prompt: 'p' });
            await TaskService.add({ name: 'T2', agent: 'a', prompt: 'p' });
            const tasks = await TaskService.list();
            expect(tasks.length).toBe(2);
        });

        test('按状态筛选', async () => {
            const t1 = await TaskService.add({ name: 'T1', agent: 'a', prompt: 'p' });
            await TaskService.start(t1.id);
            await TaskService.done(t1.id);
            await TaskService.add({ name: 'T2', agent: 'a', prompt: 'p' });

            const doneTasks = await TaskService.list({ status: 'done' });
            expect(doneTasks.length).toBe(1);
            expect(doneTasks[0].status).toBe('done');
        });

        test('按 batchId 筛选', async () => {
            await TaskService.add({ name: 'T1', agent: 'a', prompt: 'p', batchId: 'b1' });
            await TaskService.add({ name: 'T2', agent: 'a', prompt: 'p', batchId: 'b2' });

            const tasks = await TaskService.list({ batchId: 'b1' });
            expect(tasks.length).toBe(1);
        });

        test('按 category 筛选', async () => {
            await TaskService.add({ name: 'T1', agent: 'a', prompt: 'p', category: 'translate' });
            await TaskService.add({ name: 'T2', agent: 'a', prompt: 'p', category: 'generate' });

            const tasks = await TaskService.list({ category: 'translate' });
            expect(tasks.length).toBe(1);
        });

        test('分页 limit + offset', async () => {
            for (let i = 0; i < 5; i++) {
                await TaskService.add({ name: `T${i}`, agent: 'a', prompt: 'p' });
            }
            const page1 = await TaskService.list({ limit: 2 });
            const page2 = await TaskService.list({ limit: 2, offset: 2 });
            expect(page1.length).toBe(2);
            expect(page2.length).toBe(2);
            expect(page1[0].id).not.toBe(page2[0].id);
        });

        test('按 ID 倒序（新任务在前）', async () => {
            await TaskService.add({ name: 'T1', agent: 'a', prompt: 'p' });
            await TaskService.add({ name: 'T2', agent: 'a', prompt: 'p' });
            const tasks = await TaskService.list();
            expect(tasks.length).toBe(2);
            expect(tasks[0].id).toBeGreaterThan(tasks[1].id as number);
        });
    });

    describe('stats', () => {
        test('统计各状态数量', async () => {
            const t1 = await TaskService.add({ name: 'T1', agent: 'a', prompt: 'p' });
            const t2 = await TaskService.add({ name: 'T2', agent: 'a', prompt: 'p' });
            await TaskService.add({ name: 'T3', agent: 'a', prompt: 'p' });

            await TaskService.start(t1.id);
            await TaskService.done(t1.id);

            await TaskService.start(t2.id);
            await TaskService.fail(t2.id, '失败', {}, { setDeadLetter: true });

            const stats = await TaskService.stats();
            expect(stats.total).toBe(3);
            expect(stats.done).toBe(1);
            expect(stats.dead_letter).toBe(1);
            expect(stats.pending).toBe(1);
        });

        test('空数据库返回全零', async () => {
            const stats = await TaskService.stats();
            expect(stats.total).toBe(0);
            expect(stats.pending).toBe(0);
            expect(stats.running).toBe(0);
            expect(stats.done).toBe(0);
            expect(stats.failed).toBe(0);
            expect(stats.dead_letter).toBe(0);
            expect(stats.cancelled).toBe(0);
        });
    });

    describe('delete', () => {
        test('删除存在的任务', async () => {
            const task = await TaskService.add({ name: 'T', agent: 'a', prompt: 'p' });
            const result = await TaskService.delete(task.id);
            expect(result).toBe(true);

            const found = await TaskService.getById(task.id);
            expect(found).toBeNull();
        });

        test('删除不存在的任务返回 false', async () => {
            const result = await TaskService.delete(99999);
            expect(result).toBe(false);
        });
    });

    describe('markPendingForRetry', () => {
        test('将任务标记为 pending 并设置 retryAfter', async () => {
            const task = await TaskService.add({
                name: 'T',
                agent: 'a',
                prompt: 'p',
                maxRetries: 3,
            });
            await TaskService.start(task.id);
            await TaskService.fail(task.id, '失败');

            const retryAfter = Date.now() + 60000;
            const updated = await TaskService.markPendingForRetry(task.id, retryAfter, 2);
            expect(updated).not.toBeNull();
            expect(updated!.status).toBe('pending');
            expect(updated!.retryAfter).toBe(retryAfter);
            expect(updated!.retryCount).toBe(2);
            expect(updated!.startedAt).toBeNull();
            expect(updated!.finishedAt).toBeNull();
        });
    });

    describe('markDeadLetter', () => {
        test('将任务标记为 dead_letter', async () => {
            const task = await TaskService.add({ name: 'T', agent: 'a', prompt: 'p' });
            await TaskService.start(task.id);

            const updated = await TaskService.markDeadLetter(task.id, 5);
            expect(updated).not.toBeNull();
            expect(updated!.status).toBe('dead_letter');
            expect(updated!.retryCount).toBe(5);
            expect(updated!.finishedAt).not.toBeNull();
        });
    });

    describe('batchId 传递链路', () => {
        test('add 时传入 batchId，getById 返回的 batchId 一致', async () => {
            const task = await TaskService.add({
                name: '文档翻译批次',
                agent: 'translator',
                prompt: '翻译技术文档',
                batchId: 'translate-batch-001',
            });

            const found = await TaskService.getById(task.id);
            expect(found).not.toBeNull();
            expect(found!.batchId).toBe('translate-batch-001');
        });

        test('add 时不传 batchId，默认为 null', async () => {
            const task = await TaskService.add({
                name: '独立审查任务',
                agent: 'reviewer',
                prompt: '审查代码质量',
            });

            const found = await TaskService.getById(task.id);
            expect(found).not.toBeNull();
            expect(found!.batchId).toBeNull();
        });

        test('next 排除活跃批次时，batchId 正确过滤', async () => {
            await TaskService.add({
                name: '批次A任务一',
                agent: 'a',
                prompt: '处理数据',
                batchId: 'batch-a',
            });
            await TaskService.add({
                name: '批次A任务二',
                agent: 'a',
                prompt: '清洗数据',
                batchId: 'batch-a',
            });
            const batchBTask = await TaskService.add({
                name: '批次B任务',
                agent: 'a',
                prompt: '生成报告',
                batchId: 'batch-b',
            });

            const next = await TaskService.next({ excludedBatchIds: ['batch-a'] });
            expect(next).not.toBeNull();
            expect(next!.id).toBe(batchBTask.id);
            expect(next!.batchId).toBe('batch-b');
        });

        test('start 任务后，batchId 不变', async () => {
            const task = await TaskService.add({
                name: '数据分析任务',
                agent: 'analyst',
                prompt: '分析用户行为数据',
                batchId: 'analytics-batch',
            });

            const started = await TaskService.start(task.id);
            expect(started).not.toBeNull();
            expect(started!.status).toBe('running');
            expect(started!.batchId).toBe('analytics-batch');

            const found = await TaskService.getById(task.id);
            expect(found!.batchId).toBe('analytics-batch');
        });

        test('done 任务后，batchId 保持不变', async () => {
            const task = await TaskService.add({
                name: '图片生成任务',
                agent: 'designer',
                prompt: '生成首页 Banner',
                batchId: 'design-batch',
            });

            await TaskService.start(task.id);
            const finished = await TaskService.done(task.id, '生成完成');
            expect(finished!.batchId).toBe('design-batch');

            const found = await TaskService.getById(task.id);
            expect(found!.batchId).toBe('design-batch');
        });

        test('fail 任务后，batchId 保持不变', async () => {
            const task = await TaskService.add({
                name: '部署任务',
                agent: 'devops',
                prompt: '部署到预发布环境',
                batchId: 'deploy-batch',
                maxRetries: 3,
            });

            await TaskService.start(task.id);
            const failed = await TaskService.fail(task.id, '部署超时');
            expect(failed!.batchId).toBe('deploy-batch');

            const found = await TaskService.getById(task.id);
            expect(found!.batchId).toBe('deploy-batch');
        });

        test('retryBatch 后，retryCount 重置且 batchId 不变', async () => {
            const task = await TaskService.add({
                name: '邮件发送任务',
                agent: 'mailer',
                prompt: '发送活动通知邮件',
                batchId: 'notification-batch',
                maxRetries: 5,
            });

            await TaskService.start(task.id);
            const failed = await TaskService.fail(task.id, 'SMTP 连接超时');
            expect(failed!.retryCount).toBe(1);
            expect(failed!.batchId).toBe('notification-batch');

            await TaskService.retryBatch('notification-batch');

            const found = await TaskService.getById(task.id);
            expect(found!.status).toBe('pending');
            expect(found!.batchId).toBe('notification-batch');
            expect(found!.retryCount).toBe(0);
        });

        test('不同批次互不干扰', async () => {
            const t1 = await TaskService.add({
                name: '数据处理任务一',
                agent: 'a',
                prompt: '清洗订单数据',
                batchId: 'batch-x',
            });
            const t2 = await TaskService.add({
                name: '数据处理任务二',
                agent: 'a',
                prompt: '计算统计指标',
                batchId: 'batch-x',
            });
            await TaskService.start(t1.id);
            await TaskService.done(t1.id);
            await TaskService.start(t2.id);
            await TaskService.done(t2.id);
            await TaskService.add({
                name: '数据处理任务三',
                agent: 'a',
                prompt: '生成可视化报表',
                batchId: 'batch-x',
            });

            const t4 = await TaskService.add({
                name: '日志分析任务',
                agent: 'a',
                prompt: '分析服务端错误日志',
                batchId: 'batch-y',
                maxRetries: 3,
            });
            await TaskService.start(t4.id);
            await TaskService.fail(t4.id, '日志文件不存在');

            const statsX = await TaskService.stats({ batchId: 'batch-x' });
            expect(statsX.total).toBe(3);
            expect(statsX.done).toBe(2);
            expect(statsX.pending).toBe(1);
            expect(statsX.failed).toBe(0);

            const listY = await TaskService.list({ batchId: 'batch-y' });
            expect(listY.length).toBe(1);
            expect(listY[0].batchId).toBe('batch-y');
            expect(listY[0].status).toBe('failed');
        });
    });

    describe('resetRunningToPending', () => {
        test('批量重置 running 任务为 pending', async () => {
            const t1 = await TaskService.add({ name: 'T1', agent: 'a', prompt: 'p' });
            const t2 = await TaskService.add({ name: 'T2', agent: 'a', prompt: 'p' });
            await TaskService.start(t1.id);
            await TaskService.start(t2.id);

            const count = await TaskService.resetRunningToPending([t1.id, t2.id]);
            expect(count).toBe(2);

            const r1 = await TaskService.getById(t1.id);
            const r2 = await TaskService.getById(t2.id);
            expect(r1!.status).toBe('pending');
            expect(r2!.status).toBe('pending');
        });

        test('不重置非 running 任务', async () => {
            const t1 = await TaskService.add({ name: 'T1', agent: 'a', prompt: 'p' });
            const count = await TaskService.resetRunningToPending([t1.id]);
            expect(count).toBe(0);
        });

        test('空数组返回 0', async () => {
            const count = await TaskService.resetRunningToPending([]);
            expect(count).toBe(0);
        });
    });
});
