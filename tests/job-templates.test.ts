import { describe, test, expect, beforeEach } from 'bun:test';
import { setupTestDb } from './helpers/mock-db';
import {
    cloneTaskFromTemplate,
    getDueTemplates,
    initializeNextRunAt,
    triggerTaskFromTemplate,
} from '../src/gateway/scheduler/job-templates';
import { TaskTemplateService } from '../src/core/services/task-template.service';
import { TaskService } from '../src/core/services/task.service';
import { TaskRunService } from '../src/core/services/task-run.service';

let testDb: ReturnType<typeof setupTestDb>;

describe('job-templates', () => {
    beforeEach(() => {
        testDb = setupTestDb();
    });

    describe('cloneTaskFromTemplate', () => {
        test('从模板克隆任务', async () => {
            const tmpl = await TaskTemplateService.create({
                name: '每日报告',
                agent: 'reporter',
                prompt: '生成每日报告',
                scheduleType: 'recurring',
                intervalMs: 86400000,
            });

            const task = await cloneTaskFromTemplate(tmpl.id);
            expect(task).not.toBeNull();
            expect(task!.name).toBe('每日报告');
            expect(task!.agent).toBe('reporter');
            expect(task!.templateId).toBe(tmpl.id);
            expect(task!.status).toBe('pending');
        });

        test('完整传递项目、批次、超时和重试配置', async () => {
            const tmpl = await TaskTemplateService.create({
                name: '项目内定时任务',
                agent: 'reviewer',
                prompt: '检查项目',
                cwd: '/tmp/中文项目',
                batchId: '每日检查',
                scheduleType: 'recurring',
                intervalMs: 60_000,
                maxRetries: 4,
                retryBackoffMs: 12_345,
                timeoutMs: 90_000,
            });

            const task = await cloneTaskFromTemplate(tmpl.id);
            expect(task).toMatchObject({
                cwd: '/tmp/中文项目',
                batchId: '每日检查',
                maxRetries: 4,
                retryBackoffMs: 12_345,
                timeoutMs: 90_000,
            });
        });

        test('不存在的模板返回 null', async () => {
            const result = await cloneTaskFromTemplate(99999);
            expect(result).toBeNull();
        });

        test('maxInstances 限制并发实例数', async () => {
            const tmpl = await TaskTemplateService.create({
                name: '受限模板',
                agent: 'a',
                prompt: 'p',
                scheduleType: 'recurring',
                intervalMs: 3600000,
                maxInstances: 1,
            });

            const task1 = await cloneTaskFromTemplate(tmpl.id);
            expect(task1).not.toBeNull();

            const task2 = await cloneTaskFromTemplate(tmpl.id);
            expect(task2).toBeNull();
        });

        test('等待自动重试的 failed 实例仍占用 maxInstances', async () => {
            const tmpl = await TaskTemplateService.create({
                name: '失败重试受限模板', agent: 'a', prompt: 'p',
                scheduleType: 'recurring', intervalMs: 1000, maxInstances: 1, maxRetries: 2,
            });
            const first = await cloneTaskFromTemplate(tmpl.id);
            await TaskService.start(first!.id);
            await TaskService.fail(first!.id, '等待自动重试');

            expect(await cloneTaskFromTemplate(tmpl.id)).toBeNull();
        });

        test('已取消但 run 未关闭的实例仍占用 maxInstances', async () => {
            const tmpl = await TaskTemplateService.create({
                name: '取消收敛模板', agent: 'a', prompt: 'p',
                scheduleType: 'recurring', intervalMs: 1000, maxInstances: 1,
            });
            const first = await cloneTaskFromTemplate(tmpl.id);
            await TaskService.start(first!.id);
            await TaskRunService.create({ taskId: first!.id, status: 'running' });
            await TaskService.cancel(first!.id);

            expect(await cloneTaskFromTemplate(tmpl.id)).toBeNull();
            expect(await triggerTaskFromTemplate(tmpl.id)).toBeNull();
        });

        test('模板更新失败时回滚已插入任务', async () => {
            const tmpl = await TaskTemplateService.create({
                name: '事务回滚模板', agent: 'a', prompt: 'p',
                scheduleType: 'recurring', intervalMs: 1000,
            });
            testDb.sqlite.exec(`
                CREATE TRIGGER reject_template_update
                BEFORE UPDATE ON task_templates
                BEGIN
                    SELECT RAISE(ABORT, '模拟模板更新失败');
                END;
            `);

            await expect(cloneTaskFromTemplate(tmpl.id)).rejects.toThrow('模拟模板更新失败');
            expect(await TaskService.list()).toHaveLength(0);
        });

        test('模板完成时允许再次克隆', async () => {
            const tmpl = await TaskTemplateService.create({
                name: '可重复模板',
                agent: 'a',
                prompt: 'p',
                scheduleType: 'recurring',
                intervalMs: 3600000,
                maxInstances: 1,
            });

            const task1 = await cloneTaskFromTemplate(tmpl.id);
            expect(task1).not.toBeNull();

            await TaskService.start(task1!.id);
            await TaskService.done(task1!.id);

            const task2 = await cloneTaskFromTemplate(tmpl.id);
            expect(task2).not.toBeNull();
        });

        test('手动触发服从 maxInstances 且不推进模板调度时间', async () => {
            const template = await TaskTemplateService.create({
                name: '手动触发模板',
                agent: 'test-agent',
                prompt: '执行',
                scheduleType: 'recurring',
                intervalMs: 60_000,
                maxInstances: 1,
            });
            const before = await TaskTemplateService.getById(template.id);

            const task = await triggerTaskFromTemplate(template.id);
            expect(task?.name).toBe('[手动触发] 手动触发模板');
            expect(await triggerTaskFromTemplate(template.id)).toBeNull();

            const after = await TaskTemplateService.getById(template.id);
            expect(after?.lastRunAt).toBe(before?.lastRunAt);
            expect(after?.nextRunAt).toBe(before?.nextRunAt);
        });

        test('更新模板的 lastRunAt 和 nextRunAt', async () => {
            const before = Date.now();
            const tmpl = await TaskTemplateService.create({
                name: '更新检查',
                agent: 'a',
                prompt: 'p',
                scheduleType: 'recurring',
                intervalMs: 3600000,
            });

            await cloneTaskFromTemplate(tmpl.id);

            const updated = await TaskTemplateService.getById(tmpl.id);
            expect(updated!.lastRunAt!).toBeGreaterThanOrEqual(before);
            expect(updated!.nextRunAt).not.toBeNull();
        });
    });

    test('模板同毫秒创建时用较大 ID 排在前面', async () => {
        await TaskTemplateService.create({
            name: '模板一', agent: 'a', prompt: 'p', scheduleType: 'recurring', intervalMs: 60_000,
        });
        const second = await TaskTemplateService.create({
            name: '模板二', agent: 'a', prompt: 'p', scheduleType: 'recurring', intervalMs: 60_000,
        });

        const templates = await TaskTemplateService.list();
        expect(templates[0].id).toBe(second.id);
    });

    describe('getDueTemplates', () => {
        test('返回到期的启用模板', async () => {
            await TaskTemplateService.create({
                name: '到期模板',
                agent: 'a',
                prompt: 'p',
                scheduleType: 'delayed',
                runAt: Date.now() - 1000,
            });

            const due = await getDueTemplates();
            expect(due.length).toBe(1);
        });

        test('不返回未到期的模板', async () => {
            await TaskTemplateService.create({
                name: '未到期模板',
                agent: 'a',
                prompt: 'p',
                scheduleType: 'delayed',
                runAt: Date.now() + 3600000,
            });

            const due = await getDueTemplates();
            expect(due.length).toBe(0);
        });

        test('不返回禁用的模板', async () => {
            const tmpl = await TaskTemplateService.create({
                name: '禁用模板',
                agent: 'a',
                prompt: 'p',
                scheduleType: 'delayed',
                runAt: Date.now() - 1000,
            });
            await TaskTemplateService.disable(tmpl.id);

            const due = await getDueTemplates();
            expect(due.length).toBe(0);
        });
    });

    describe('模板参数校验', () => {
        const base = { name: '校验模板', agent: 'a', prompt: 'p' };

        test('拒绝缺少对应调度参数的模板', async () => {
            await expect(TaskTemplateService.create({ ...base, scheduleType: 'cron' })).rejects.toThrow('cronExpr');
            await expect(TaskTemplateService.create({ ...base, scheduleType: 'recurring' })).rejects.toThrow('intervalMs');
            await expect(TaskTemplateService.create({ ...base, scheduleType: 'delayed' })).rejects.toThrow('runAt');
        });

        test('拒绝无效数值，避免不可运行模板进入数据库', async () => {
            await expect(TaskTemplateService.create({
                ...base,
                scheduleType: 'recurring',
                intervalMs: 1000,
                maxInstances: 0,
            })).rejects.toThrow('maxInstances');
            await expect(TaskTemplateService.create({
                ...base,
                scheduleType: 'recurring',
                intervalMs: 1000,
                retryBackoffMs: -1,
            })).rejects.toThrow('retryBackoffMs');
        });
    });

    describe('initializeNextRunAt', () => {
        test('为 nextRunAt 为 null 的模板初始化', async () => {
            const tmpl = await TaskTemplateService.create({
                name: '初始化测试',
                agent: 'a',
                prompt: 'p',
                scheduleType: 'recurring',
                intervalMs: 3600000,
            });

            expect(tmpl.nextRunAt).not.toBeNull();
        });
    });
});
