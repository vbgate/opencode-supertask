import { describe, test, expect, beforeEach } from 'bun:test';
import { setupTestDb } from './helpers/mock-db';
import { TaskService } from '../src/core/services/task.service';
import { TaskRunService } from '../src/core/services/task-run.service';

let testDb: ReturnType<typeof setupTestDb>;

describe('TaskService', () => {
    beforeEach(() => {
        testDb = setupTestDb();
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
                variant: '  high  ',
                category: 'review',
                importance: 5,
                urgency: 5,
                batchId: 'batch-001',
                dependsOn: undefined,
                cwd: process.cwd(),
                maxRetries: 5,
            });
            expect(task.category).toBe('review');
            expect(task.importance).toBe(5);
            expect(task.urgency).toBe(5);
            expect(task.batchId).toBe('batch-001');
            expect(task.model).toBe('gpt-4');
            expect(task.variant).toBe('high');
            expect(task.cwd).toBe(process.cwd());
            expect(task.maxRetries).toBe(5);
        });

        test('拒绝不可执行的任务参数', async () => {
            await expect(TaskService.add({ name: '', agent: 'a', prompt: 'p' })).rejects.toThrow('name');
            await expect(TaskService.add({ name: '任务', agent: 'a', prompt: 'p', importance: 6 })).rejects.toThrow('importance');
            await expect(TaskService.add({ name: '任务', agent: 'a', prompt: 'p', maxRetries: -1 })).rejects.toThrow('maxRetries');
            await expect(TaskService.add({ name: '任务', agent: 'a', prompt: 'p', timeoutMs: 999 })).rejects.toThrow('timeoutMs');
            await expect(TaskService.add({ name: '任务', agent: 'a', prompt: 'p', variant: 'x'.repeat(129) })).rejects.toThrow('variant');
            await expect(TaskService.add({ name: '任务', agent: 'a', prompt: 'p', variant: 'high\u0000bad' })).rejects.toThrow('控制字符');
        });

        test('批次 ID 去除首尾空白，空白批次统一保存为无批次', async () => {
            const grouped = await TaskService.add({
                name: '规范批次', agent: 'a', prompt: 'p', batchId: '  release  ',
            });
            const ungrouped = await TaskService.add({
                name: '无批次', agent: 'a', prompt: 'p', batchId: '   ',
            });

            expect(grouped.batchId).toBe('release');
            expect(ungrouped.batchId).toBeNull();
            expect((await TaskService.update(grouped.id, { batchId: '' }))?.batchId).toBeNull();
        });

        test('拒绝不存在、相对路径或文件作为工作目录', async () => {
            await expect(TaskService.add({
                name: '不存在目录', agent: 'a', prompt: 'p', cwd: `${process.cwd()}/不存在的-supertask-cwd`,
            })).rejects.toThrow('不存在或无法访问');
            await expect(TaskService.add({
                name: '相对目录', agent: 'a', prompt: 'p', cwd: 'relative/project',
            })).rejects.toThrow('绝对路径');
            await expect(TaskService.add({
                name: '文件路径', agent: 'a', prompt: 'p', cwd: `${process.cwd()}/package.json`,
            })).rejects.toThrow('不是目录');
        });

        test('拒绝不存在或跨 cwd 的依赖任务', async () => {
            await expect(TaskService.add({
                name: '悬空依赖任务', agent: 'a', prompt: 'p', cwd: process.cwd(), dependsOn: 99999,
            })).rejects.toThrow('不存在');

            const dependency = await TaskService.add({
                name: '另一个项目的前置任务', agent: 'a', prompt: 'p', cwd: '/tmp',
            });
            await expect(TaskService.add({
                name: '跨项目依赖任务', agent: 'a', prompt: 'p', cwd: process.cwd(), dependsOn: dependency.id,
            })).rejects.toThrow('同一 cwd');
        });

        test('拒绝依赖已经进入不可恢复终态的任务', async () => {
            const dependency = await TaskService.add({
                name: '已结束前置', agent: 'a', prompt: 'p', cwd: process.cwd(),
            });
            await TaskService.cancel(dependency.id);

            expect(TaskService.add({
                name: '不会永久阻塞的下游',
                agent: 'a',
                prompt: 'p',
                cwd: process.cwd(),
                dependsOn: dependency.id,
            })).rejects.toThrow('不可恢复终态');
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
                cwd: process.cwd(),
            });
            await TaskService.add({
                name: '项目B任务',
                agent: 'agent-b',
                prompt: '测试',
                cwd: '/tmp',
            });

            const found = await TaskService.getById(t1.id, { cwd: process.cwd() });
            expect(found).not.toBeNull();

            const notFound = await TaskService.getById(t1.id, { cwd: '/tmp' });
            expect(notFound).toBeNull();
        });
    });

    describe('update', () => {
        test('修改待执行任务的模型、提示词、优先级和批次，但保持项目目录', async () => {
            const task = await TaskService.add({
                name: '待编辑', agent: 'build', prompt: '旧提示词', cwd: process.cwd(),
            });
            const updated = await TaskService.update(task.id, {
                model: 'openai/gpt-5',
                variant: 'xhigh',
                prompt: '新提示词',
                importance: 5,
                urgency: 4,
                batchId: 'review',
                timeoutMs: 60_000,
            }, { cwd: process.cwd() });

            expect(updated).toMatchObject({
                model: 'openai/gpt-5', variant: 'xhigh', prompt: '新提示词', importance: 5, urgency: 4,
                batchId: 'review', timeoutMs: 60_000, cwd: process.cwd(), status: 'pending',
            });

            expect((await TaskService.update(task.id, { prompt: '保留 variant' }))?.variant).toBe('xhigh');
            expect((await TaskService.update(task.id, { variant: '' }))?.variant).toBeNull();
        });

        test('拒绝编辑运行中、已完成、已取消或其他项目的任务', async () => {
            const running = await TaskService.add({
                name: '运行中', agent: 'a', prompt: 'p', cwd: process.cwd(),
            });
            const done = await TaskService.add({ name: '已完成', agent: 'a', prompt: 'p' });
            const cancelled = await TaskService.add({ name: '已取消', agent: 'a', prompt: 'p' });
            await TaskService.start(running.id);
            await TaskService.start(done.id);
            await TaskService.done(done.id);
            await TaskService.cancel(cancelled.id);
            expect(await TaskService.update(running.id, { model: 'new' })).toBeNull();
            expect(await TaskService.update(done.id, { model: 'new' })).toBeNull();
            expect(await TaskService.update(cancelled.id, { model: 'new' })).toBeNull();
            expect(await TaskService.update(running.id, { model: 'new' }, { cwd: '/tmp' })).toBeNull();
        });

        test('降低等待重试任务的预算时立即收敛到 dead_letter', async () => {
            const task = await TaskService.add({
                name: '等待重试', agent: 'a', prompt: 'p', maxRetries: 3,
            });
            await TaskService.start(task.id);
            await TaskService.fail(task.id, '失败');

            expect(await TaskService.update(task.id, { maxRetries: 0 })).toMatchObject({
                status: 'dead_letter', maxRetries: 0, retryAfter: null,
            });
        });

        test('降低重试预算进入 dead_letter 时递归收敛依赖链', async () => {
            const prerequisite = await TaskService.add({
                name: '前置任务', agent: 'a', prompt: 'p', maxRetries: 3,
            });
            const dependent = await TaskService.add({
                name: '直接依赖', agent: 'a', prompt: 'p', dependsOn: prerequisite.id,
            });
            const descendant = await TaskService.add({
                name: '间接依赖', agent: 'a', prompt: 'p', dependsOn: dependent.id,
            });
            await TaskService.start(prerequisite.id);
            await TaskService.fail(prerequisite.id, '失败');

            await TaskService.update(prerequisite.id, { maxRetries: 0 });

            expect(await TaskService.getById(dependent.id)).toMatchObject({
                status: 'dead_letter',
                resultLog: `依赖任务 #${prerequisite.id} 已进入不可恢复终态`,
            });
            expect(await TaskService.getById(descendant.id)).toMatchObject({
                status: 'dead_letter',
                resultLog: `依赖任务 #${prerequisite.id} 已进入不可恢复终态`,
            });
        });
    });

    describe('next', () => {
        test('claimNext 原子选择任务并返回已抢占的最新记录', async () => {
            const task = await TaskService.add({
                name: '原子抢占', agent: 'a', prompt: '最新提示词', batchId: 'claim-batch',
            });

            const claimed = await TaskService.claimNext();

            expect(claimed).toMatchObject({
                id: task.id,
                prompt: '最新提示词',
                batchId: 'claim-batch',
                status: 'running',
            });
            expect(claimed?.startedAt).toBeInstanceOf(Date);
            expect(await TaskService.claimNext()).toBeNull();
        });

        test('并发 claimNext 不会同时抢占同一批次', async () => {
            await TaskService.add({
                name: '批次一', agent: 'a', prompt: 'p', batchId: 'serial-claim',
            });
            await TaskService.add({
                name: '批次二', agent: 'a', prompt: 'p', batchId: 'serial-claim',
            });

            const claimed = await Promise.all([
                TaskService.claimNext(),
                TaskService.claimNext(),
            ]);

            expect(claimed.filter(Boolean)).toHaveLength(1);
            expect(await TaskService.countRunning({ batchId: 'serial-claim' })).toBe(1);
        });

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
                cwd: process.cwd(),
            });
            const t2 = await TaskService.add({
                name: '项目B',
                agent: 'a',
                prompt: 'p',
                cwd: '/tmp',
            });

            const next = await TaskService.next({ cwd: '/tmp' });
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

        test('数据库中已有运行任务时自动排除同一批次', async () => {
            const running = await TaskService.add({
                name: '崩溃前运行任务', agent: 'a', prompt: 'p', batchId: '关键批次',
            });
            const waiting = await TaskService.add({
                name: '同批次等待任务', agent: 'a', prompt: 'p', batchId: '关键批次',
            });
            const other = await TaskService.add({
                name: '其他批次任务', agent: 'a', prompt: 'p', batchId: '其他批次',
            });
            await TaskService.start(running.id);

            expect((await TaskService.next())?.id).toBe(other.id);
            await TaskService.cancel(other.id);
            expect(await TaskService.next()).toBeNull();
            expect((await TaskService.getById(waiting.id))?.status).toBe('pending');
        });

        test('旧数据库中的各类纯空白 batchId 按无批次处理，不会互相阻塞', async () => {
            const [emptyBatch, whitespaceBatch, tabBatch] = await testDb.db
                .insert(testDb.schema.tasks)
                .values([
                    { name: '旧空批次', agent: 'a', prompt: 'p', batchId: '' },
                    { name: '旧空白批次', agent: 'a', prompt: 'p', batchId: '   ' },
                    { name: '旧 Tab 批次', agent: 'a', prompt: 'p', batchId: '\t\n' },
                ])
                .returning();
            await TaskService.start(emptyBatch.id);

            expect((await TaskService.next())?.id).toBe(whitespaceBatch.id);
            await TaskService.start(whitespaceBatch.id);
            expect((await TaskService.next())?.id).toBe(tabBatch.id);
        });

        test.each([
            ['普通空格', ' shared '],
            ['Tab', '\tshared\t'],
            ['NBSP', '\u00a0shared\u00a0'],
        ])('旧数据库中带%s的非空 batchId 仍与规范化批次全局串行', async (_kind, legacyBatchId) => {
            const [legacyRunning, legacyFailed] = await testDb.db
                .insert(testDb.schema.tasks)
                .values([
                    { name: '旧批次运行中', agent: 'a', prompt: 'p', batchId: legacyBatchId },
                    {
                        name: '旧批次失败', agent: 'a', prompt: 'p', batchId: legacyBatchId,
                        status: 'failed', retryCount: 1, maxRetries: 0,
                    },
                ])
                .returning();
            expect(await TaskService.next({ excludedBatchIds: ['shared'] })).toBeNull();
            await TaskService.start(legacyRunning.id);
            const modern = await TaskService.add({
                name: '新批次等待', agent: 'a', prompt: 'p', batchId: 'shared',
            });

            expect(await TaskService.next()).toBeNull();
            expect(await TaskService.countRunning({ batchId: ' shared ' })).toBe(1);
            expect(await TaskService.stats({ batchId: 'shared' })).toMatchObject({
                total: 3, running: 1, pending: 1, failed: 1,
            });
            expect((await TaskService.list({ batchId: 'shared' })).map((task) => task.id))
                .toEqual([modern.id, legacyFailed.id, legacyRunning.id]);

            expect(await TaskService.retryBatch(' shared ')).toBe(1);
            expect((await TaskService.getById(legacyFailed.id))?.status).toBe('pending');
        });

        test('已取消但 run 尚未关闭时继续占用并发和批次锁', async () => {
            const active = await TaskService.add({
                name: '取消收敛中', agent: 'a', prompt: 'p', batchId: 'batch-cancelling',
            });
            const sameBatch = await TaskService.add({
                name: '同批次等待', agent: 'a', prompt: 'p', batchId: 'batch-cancelling',
            });
            const other = await TaskService.add({
                name: '其他批次', agent: 'a', prompt: 'p', batchId: 'batch-other',
            });
            await TaskService.start(active.id);
            await TaskRunService.create({ taskId: active.id, status: 'running' });
            await TaskService.cancel(active.id);

            expect(await TaskService.countRunning()).toBe(1);
            expect((await TaskService.next())?.id).toBe(other.id);
            expect((await TaskService.getById(sameBatch.id))?.status).toBe('pending');
        });

        test('任务被重置为 pending 但仍有 active run 时不能再次派发', async () => {
            const task = await TaskService.add({
                name: '关停中断窗口', agent: 'a', prompt: 'p',
            });
            await TaskService.start(task.id);
            await TaskRunService.create({ taskId: task.id, status: 'running' });
            await TaskService.resetRunningToPending([task.id]);

            expect(await TaskService.next()).toBeNull();
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

        test('任务级 retryBackoffMs 控制自动退避', async () => {
            const task = await TaskService.add({
                name: '自定义退避',
                agent: 'test',
                prompt: '测试',
                maxRetries: 1,
                retryBackoffMs: 5000,
            });
            await TaskService.start(task.id);
            const before = Date.now();
            const failed = await TaskService.fail(task.id, '失败');

            expect(failed!.retryAfter!).toBeGreaterThanOrEqual(before + 5000);
            expect(failed!.retryAfter!).toBeLessThanOrEqual(Date.now() + 5000);
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

        test('一次恢复同批次三层依赖闭包，并保持逐级调度', async () => {
            const root = await TaskService.add({
                name: '根任务', agent: 'a', prompt: 'p', batchId: 'closure', cwd: process.cwd(),
            });
            const middle = await TaskService.add({
                name: '中间任务', agent: 'a', prompt: 'p', batchId: 'closure', cwd: process.cwd(),
                dependsOn: root.id,
            });
            const leaf = await TaskService.add({
                name: '叶子任务', agent: 'a', prompt: 'p', batchId: 'closure', cwd: process.cwd(),
                dependsOn: middle.id,
            });
            testDb.sqlite.query(`
                UPDATE tasks
                SET status = 'dead_letter', retry_count = 1, max_retries = 0, finished_at = 1
                WHERE id IN (?, ?, ?)
            `).run(root.id, middle.id, leaf.id);

            expect(await TaskService.retryBatch('closure', { cwd: process.cwd() })).toBe(3);

            expect((await TaskService.next({ cwd: process.cwd() }))?.id).toBe(root.id);
            await TaskService.start(root.id);
            await TaskService.done(root.id);
            expect((await TaskService.next({ cwd: process.cwd() }))?.id).toBe(middle.id);
            await TaskService.start(middle.id);
            await TaskService.done(middle.id);
            expect((await TaskService.next({ cwd: process.cwd() }))?.id).toBe(leaf.id);
        });

        test('缺失、跨 cwd 与环形依赖不会被批量重试恢复', async () => {
            const missingParent = await TaskService.add({
                name: '将被删除的父任务', agent: 'a', prompt: 'p', batchId: 'other', cwd: process.cwd(),
            });
            const missingChild = await TaskService.add({
                name: '悬空子任务', agent: 'a', prompt: 'p', batchId: 'missing', cwd: process.cwd(),
                dependsOn: missingParent.id,
            });
            testDb.sqlite.query('DELETE FROM tasks WHERE id = ?').run(missingParent.id);
            testDb.sqlite.query("UPDATE tasks SET status = 'dead_letter' WHERE id = ?").run(missingChild.id);
            expect(await TaskService.retryBatch('missing', { cwd: process.cwd() })).toBe(0);

            const crossParent = await TaskService.add({
                name: '跨项目父任务', agent: 'a', prompt: 'p', batchId: 'other', cwd: process.cwd(),
            });
            const crossChild = await TaskService.add({
                name: '跨项目子任务', agent: 'a', prompt: 'p', batchId: 'cross', cwd: process.cwd(),
                dependsOn: crossParent.id,
            });
            testDb.sqlite.query("UPDATE tasks SET cwd = '/other' WHERE id = ?").run(crossParent.id);
            testDb.sqlite.query("UPDATE tasks SET status = 'done' WHERE id = ?").run(crossParent.id);
            testDb.sqlite.query("UPDATE tasks SET status = 'dead_letter' WHERE id = ?").run(crossChild.id);
            expect(await TaskService.retryBatch('cross', { cwd: process.cwd() })).toBe(0);

            const first = await TaskService.add({ name: '环一', agent: 'a', prompt: 'p', batchId: 'cycle' });
            const second = await TaskService.add({ name: '环二', agent: 'a', prompt: 'p', batchId: 'cycle' });
            testDb.sqlite.query(`
                UPDATE tasks
                SET status = 'dead_letter', depends_on = CASE id WHEN ? THEN ? ELSE ? END
                WHERE id IN (?, ?)
            `).run(first.id, second.id, first.id, first.id, second.id);
            expect(await TaskService.retryBatch('cycle')).toBe(0);
        });

        test('深依赖链使用集合递归恢复，不随路径字符串二次增长', async () => {
            const insert = testDb.sqlite.prepare(`
                INSERT INTO tasks (
                    name, agent, prompt, batch_id, status, depends_on,
                    retry_count, max_retries, finished_at
                ) VALUES (?, 'a', 'p', 'deep-closure', 'dead_letter', ?, 1, 0, 1)
                RETURNING id
            `);
            let dependsOn: number | null = null;
            testDb.sqlite.transaction(() => {
                for (let index = 0; index < 1_200; index += 1) {
                    dependsOn = (insert.get(`深链 ${index}`, dependsOn) as { id: number }).id;
                }
            })();

            expect(await TaskService.retryBatch('deep-closure')).toBe(1_200);
            const pending = testDb.sqlite.query(`
                SELECT count(*) AS count FROM tasks
                WHERE batch_id = 'deep-closure' AND status = 'pending'
            `).get() as { count: number };
            expect(pending.count).toBe(1_200);
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

    describe('projectSummaries', () => {
        test('按 cwd 汇总项目任务状态并排除旧版未分组任务', async () => {
            const done = await TaskService.add({
                name: '项目 A 已完成', agent: 'a', prompt: 'p', cwd: process.cwd(),
            });
            const running = await TaskService.add({
                name: '项目 A 运行中', agent: 'a', prompt: 'p', cwd: process.cwd(),
            });
            const failed = await TaskService.add({
                name: '项目 B 异常', agent: 'a', prompt: 'p', cwd: '/tmp', maxRetries: 0,
            });
            await TaskService.add({ name: '项目 B 排队', agent: 'a', prompt: 'p', cwd: '/tmp' });
            await TaskService.add({ name: '旧版未分组', agent: 'a', prompt: 'p' });

            await TaskService.start(done.id);
            await TaskService.done(done.id);
            await TaskService.start(running.id);
            await TaskService.start(failed.id);
            await TaskService.fail(failed.id, '失败', {}, { setDeadLetter: true });

            const summaries = await TaskService.projectSummaries();
            expect(summaries).toHaveLength(2);
            expect(summaries[0]).toMatchObject({
                cwd: '/tmp', total: 2, pending: 1, running: 0, failed: 1, done: 0,
            });
            expect(summaries[1]).toMatchObject({
                cwd: process.cwd(), total: 2, pending: 0, running: 1, failed: 0, done: 1,
            });
            expect(summaries[0].lastCreatedAt).toBeNumber();
        });

        test('已取消但执行进程尚未退出时仍计入项目运行数', async () => {
            const task = await TaskService.add({
                name: '正在停止', agent: 'a', prompt: 'p', cwd: process.cwd(),
            });
            await TaskService.start(task.id);
            const run = await TaskRunService.create({ taskId: task.id, status: 'running' });
            await TaskService.cancel(task.id);

            expect(await TaskService.countRunning({ cwd: process.cwd() })).toBe(1);
            expect((await TaskService.projectSummaries())[0]).toMatchObject({
                cwd: process.cwd(), running: 1,
            });
            expect(await TaskService.list({
                cwd: process.cwd(), activeExecution: true,
            })).toEqual([expect.objectContaining({ id: task.id, status: 'cancelled' })]);

            await TaskRunService.fail(run.id, '进程树已退出');
            expect(await TaskService.countRunning({ cwd: process.cwd() })).toBe(0);
            expect((await TaskService.projectSummaries())[0]).toMatchObject({
                cwd: process.cwd(), running: 0,
            });
            expect(await TaskService.list({
                cwd: process.cwd(), activeExecution: true,
            })).toHaveLength(0);
        });
    });

    describe('运行一致性', () => {
        test('任务和 run 成功状态在同一操作中完成', async () => {
            const task = await TaskService.add({ name: '原子成功任务', agent: 'a', prompt: 'p' });
            await TaskService.start(task.id);
            const run = await TaskRunService.create({ taskId: task.id, status: 'running' });

            expect((await TaskService.completeRun(task.id, run.id, '完成'))?.status).toBe('done');
            expect((await TaskRunService.getById(run.id))?.status).toBe('done');
        });

        test('任务和 run 失败状态在同一操作中完成', async () => {
            const task = await TaskService.add({
                name: '原子失败任务', agent: 'a', prompt: 'p', maxRetries: 0,
            });
            await TaskService.start(task.id);
            const run = await TaskRunService.create({ taskId: task.id, status: 'running' });

            expect((await TaskService.failRun(task.id, run.id, '失败'))?.status).toBe('dead_letter');
            expect((await TaskRunService.getById(run.id))?.status).toBe('failed');
        });

        test('确认进程退出后的停机中断会原子关闭 run 并重置任务', async () => {
            const task = await TaskService.add({
                name: '停机中断',
                agent: 'test-agent',
                prompt: '等待重新派发',
            });
            await TaskService.start(task.id);
            const run = await TaskRunService.create({ taskId: task.id, status: 'running' });

            expect(await TaskService.interruptRun(task.id, run.id, 'Gateway shutdown')).toBe(true);
            expect((await TaskService.getById(task.id))?.status).toBe('pending');
            expect((await TaskService.getById(task.id))?.retryCount).toBe(0);
            expect((await TaskRunService.getById(run.id))?.status).toBe('failed');
        });

        test('停机期间任务已取消时仍关闭 run 且不把任务恢复为 pending', async () => {
            const task = await TaskService.add({
                name: '停机取消竞态',
                agent: 'test-agent',
                prompt: '保持取消终态',
            });
            await TaskService.start(task.id);
            const run = await TaskRunService.create({ taskId: task.id, status: 'running' });
            await TaskService.cancel(task.id);

            expect(await TaskService.interruptRun(task.id, run.id, 'Gateway shutdown')).toBe(true);
            expect((await TaskService.getById(task.id))?.status).toBe('cancelled');
            expect((await TaskRunService.getById(run.id))?.status).toBe('failed');
        });

        test('依赖进入不可恢复终态后自动收敛下游任务', async () => {
            const dependency = await TaskService.add({
                name: '失败前置任务', agent: 'a', prompt: 'p', cwd: process.cwd(),
            });
            const dependent = await TaskService.add({
                name: '等待前置的任务', agent: 'a', prompt: 'p', cwd: process.cwd(), dependsOn: dependency.id,
            });
            await TaskService.cancel(dependency.id);

            const resolved = await TaskService.getById(dependent.id);
            expect(resolved?.status).toBe('dead_letter');
            expect(resolved?.resultLog).toContain('依赖任务');
            expect(await TaskService.resolveBlockedDependencies()).toBe(0);
        });

        test('不可恢复的前置任务一次事件式收敛整条依赖链', async () => {
            const root = await TaskService.add({ name: '根任务', agent: 'a', prompt: 'p' });
            let dependsOn = root.id;
            const descendants: number[] = [];
            for (let index = 0; index < 250; index += 1) {
                const task = await TaskService.add({
                    name: `下游 ${index}`,
                    agent: 'a',
                    prompt: 'p',
                    dependsOn,
                });
                descendants.push(task.id);
                dependsOn = task.id;
            }

            await TaskService.cancel(root.id);

            for (const id of descendants) {
                expect((await TaskService.getById(id))?.status).toBe('dead_letter');
            }
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

        test('拒绝直接删除 running 任务', async () => {
            const task = await TaskService.add({ name: '运行中任务', agent: 'a', prompt: 'p' });
            await TaskService.start(task.id);

            expect(TaskService.delete(task.id)).rejects.toThrow('请先取消任务');
            expect((await TaskService.getById(task.id))?.status).toBe('running');
        });

        test('取消后仍有 running 执行记录时继续拒绝删除', async () => {
            const task = await TaskService.add({ name: '取消收敛中任务', agent: 'a', prompt: 'p' });
            await TaskService.start(task.id);
            const run = await TaskRunService.create({ taskId: task.id, status: 'running' });
            await TaskService.cancel(task.id);

            expect(TaskService.delete(task.id)).rejects.toThrow('等待执行进程退出');
            await TaskRunService.fail(run.id, '任务已取消');
            expect(await TaskService.delete(task.id)).toBe(true);
        });

        test('仍被可执行任务依赖时拒绝删除前置任务', async () => {
            const prerequisite = await TaskService.add({ name: '前置任务', agent: 'a', prompt: 'p' });
            const dependent = await TaskService.add({
                name: '依赖任务',
                agent: 'a',
                prompt: 'p',
                dependsOn: prerequisite.id,
            });

            expect(TaskService.delete(prerequisite.id)).rejects.toThrow(`任务 #${dependent.id}`);
            expect(await TaskService.getById(prerequisite.id)).not.toBeNull();
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

        test('启动恢复只重置没有 active run 的孤儿 running 任务', async () => {
            const orphan = await TaskService.add({ name: '孤儿任务', agent: 'a', prompt: '恢复任务' });
            const active = await TaskService.add({ name: '执行中任务', agent: 'a', prompt: '保持执行' });
            const closed = await TaskService.add({ name: '已关闭 run 的任务', agent: 'a', prompt: '重新排队' });
            await TaskService.start(orphan.id);
            await TaskService.start(active.id);
            await TaskService.start(closed.id);
            await TaskRunService.create({ taskId: active.id });
            const closedRun = await TaskRunService.create({ taskId: closed.id });
            await TaskRunService.fail(closedRun.id, 'Gateway 在同步任务状态前退出');

            expect(await TaskService.resetOrphanRunningToPending()).toBe(2);
            expect((await TaskService.getById(orphan.id))?.status).toBe('pending');
            expect((await TaskService.getById(closed.id))?.status).toBe('pending');
            expect((await TaskService.getById(active.id))?.status).toBe('running');
        });
    });
});
