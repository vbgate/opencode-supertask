import { describe, test, expect, beforeEach } from 'bun:test';
import { setupTestDb } from './helpers/mock-db';
import {
    cloneTaskFromTemplate,
    DUE_TEMPLATE_BATCH_SIZE,
    getDueTemplates,
    initializeNextRunAt,
    triggerTaskFromTemplate,
} from '../src/gateway/scheduler/job-templates';
import { TaskTemplateService } from '../src/core/services/task-template.service';
import { TaskService } from '../src/core/services/task.service';
import { TaskRunService } from '../src/core/services/task-run.service';
import { Scheduler } from '../src/gateway/scheduler';
import type { GatewayConfig } from '../src/gateway/config';

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

        test.each(['recurring', 'cron'] as const)('%s 达到 maxInstances 时推进调度时间', async (scheduleType) => {
            const now = Date.now();
            const tmpl = await TaskTemplateService.create({
                name: `${scheduleType} 受限模板`,
                agent: 'a',
                prompt: 'p',
                scheduleType,
                ...(scheduleType === 'recurring'
                    ? { intervalMs: 60_000 }
                    : { cronExpr: '* * * * *' }),
                maxInstances: 1,
            });
            await triggerTaskFromTemplate(tmpl.id);
            testDb.sqlite.query('UPDATE task_templates SET next_run_at = ? WHERE id = ?').run(now - 1, tmpl.id);

            expect(await cloneTaskFromTemplate(tmpl.id)).toBeNull();
            const updated = await TaskTemplateService.getById(tmpl.id);
            expect(updated?.nextRunAt).toBeGreaterThan(now);
            expect(updated?.lastRunAt).toBeNull();
        });

        test('delayed 达到 maxInstances 时保留原调度时间等待执行', async () => {
            const runAt = Date.now() - 1_000;
            const tmpl = await TaskTemplateService.create({
                name: 'delayed 受限模板',
                agent: 'a',
                prompt: 'p',
                scheduleType: 'delayed',
                runAt,
                maxInstances: 1,
            });
            await triggerTaskFromTemplate(tmpl.id);

            expect(await cloneTaskFromTemplate(tmpl.id)).toBeNull();
            const updated = await TaskTemplateService.getById(tmpl.id);
            expect(updated?.nextRunAt).toBe(runAt);
            expect(updated?.enabled).toBe(true);
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

        test('每次查询有界并可用游标继续处理后续模板', async () => {
            const runAt = Date.now() - 1_000;
            const insert = testDb.sqlite.prepare(`
                INSERT INTO task_templates (
                    name, agent, prompt, schedule_type, run_at, next_run_at, enabled
                ) VALUES (?, 'a', 'p', 'delayed', ?, ?, 1)
            `);
            for (let index = 0; index < DUE_TEMPLATE_BATCH_SIZE + 5; index++) {
                insert.run(`模板 ${index}`, runAt, runAt);
            }

            const first = await getDueTemplates();
            expect(first).toHaveLength(DUE_TEMPLATE_BATCH_SIZE);
            const last = first.at(-1)!;
            const second = await getDueTemplates({ nextRunAt: last.nextRunAt!, id: last.id });
            expect(second).toHaveLength(5);
            expect(new Set([...first, ...second].map((template) => template.id)).size)
                .toBe(DUE_TEMPLATE_BATCH_SIZE + 5);
        });

        test('固定截止时间完成一轮扫描，高频 recurring 不会饿死低键失败模板', async () => {
            const failing = await TaskTemplateService.create({
                name: '失败探针',
                agent: 'a',
                prompt: 'always-fail',
                scheduleType: 'delayed',
                runAt: Date.now() - 10_000,
            });
            const dueAt = Date.now() - 1_000;
            const insert = testDb.sqlite.prepare(`
                INSERT INTO task_templates (
                    name, agent, prompt, schedule_type, interval_ms,
                    max_instances, next_run_at, enabled, created_at, updated_at
                ) VALUES (?, 'a', 'p', 'recurring', 1, 0, ?, 1, 0, 0)
            `);
            testDb.sqlite.transaction(() => {
                for (let index = 0; index < DUE_TEMPLATE_BATCH_SIZE + 1; index += 1) {
                    insert.run(`高频模板 ${index}`, dueAt);
                }
            })();
            testDb.sqlite.exec(`
                CREATE TRIGGER reject_starvation_probe
                BEFORE INSERT ON tasks
                WHEN NEW.prompt = 'always-fail'
                BEGIN
                    SELECT RAISE(ABORT, '固定失败探针');
                END;
            `);

            const config: GatewayConfig = {
                configVersion: 2,
                worker: {
                    maxConcurrency: 1,
                    pollIntervalMs: 100,
                    heartbeatIntervalMs: 1000,
                    taskTimeoutMs: 60000,
                    shutdownGracePeriodMs: 1000,
                },
                scheduler: { enabled: true, checkIntervalMs: 60000 },
                watchdog: {
                    heartbeatTimeoutMs: 60000,
                    checkIntervalMs: 60000,
                    cleanupIntervalMs: 60000,
                    retentionDays: 30,
                },
                dashboard: { enabled: false, port: 4680 },
            };
            const scheduler = new Scheduler(config);
            const tick = (scheduler as unknown as { tick(): Promise<void> }).tick.bind(scheduler);
            const errors: string[] = [];
            const originalError = console.error;
            console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));
            try {
                for (let index = 0; index < 4; index += 1) {
                    await tick();
                    await Bun.sleep(5);
                }
            } finally {
                console.error = originalError;
            }

            const visits = errors.filter((entry) => (
                entry.includes('failed to clone from template')
                && entry.includes(`\"templateId\":${failing.id}`)
            ));
            expect(visits.length).toBeGreaterThanOrEqual(2);
            expect((await TaskTemplateService.getById(failing.id))?.lastRunAt).toBeNull();
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

        test('创建时原子写入 nextRunAt，不留下依赖二次更新的幽灵模板', async () => {
            testDb.sqlite.exec(`
                CREATE TRIGGER reject_template_update
                BEFORE UPDATE ON task_templates
                BEGIN
                    SELECT RAISE(ABORT, '禁止二次更新');
                END;
            `);

            const template = await TaskTemplateService.create({
                ...base,
                scheduleType: 'recurring',
                intervalMs: 60_000,
            });
            expect(template.nextRunAt).not.toBeNull();
            expect(await TaskTemplateService.list()).toHaveLength(1);
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

        test('只分页初始化 enabled 且 nextRunAt 为空的模板', async () => {
            const insert = testDb.sqlite.prepare(`
                INSERT INTO task_templates (
                    name, agent, prompt, schedule_type, interval_ms,
                    enabled, next_run_at, created_at, updated_at
                ) VALUES (?, 'a', 'p', 'recurring', 60000, ?, NULL, 0, 0)
            `);
            testDb.sqlite.transaction(() => {
                for (let index = 0; index < 205; index += 1) insert.run(`启用模板 ${index}`, 1);
                insert.run('禁用历史模板', 0);
            })();
            const config: GatewayConfig = {
                configVersion: 2,
                worker: {
                    maxConcurrency: 1,
                    pollIntervalMs: 100,
                    heartbeatIntervalMs: 1000,
                    taskTimeoutMs: 60000,
                    shutdownGracePeriodMs: 1000,
                },
                scheduler: { enabled: true, checkIntervalMs: 60000 },
                watchdog: {
                    heartbeatTimeoutMs: 60000,
                    checkIntervalMs: 60000,
                    cleanupIntervalMs: 60000,
                    retentionDays: 30,
                },
                dashboard: { enabled: false, port: 4680 },
            };
            const scheduler = new Scheduler(config);
            await scheduler.start();
            scheduler.stop();

            const initialized = testDb.sqlite.query(`
                SELECT count(*) AS count FROM task_templates
                WHERE enabled = 1 AND next_run_at IS NOT NULL
            `).get() as { count: number };
            const disabled = testDb.sqlite.query(`
                SELECT enabled, next_run_at AS nextRunAt FROM task_templates
                WHERE name = '禁用历史模板'
            `).get() as { enabled: number; nextRunAt: number | null };
            expect(initialized.count).toBe(205);
            expect(disabled).toEqual({ enabled: 0, nextRunAt: null });
        });

        test('initializeNextRunAt 在更新处重验 enabled 与空调度时间', async () => {
            const tmpl = await TaskTemplateService.create({
                name: '禁用竞态模板', agent: 'a', prompt: 'p',
                scheduleType: 'recurring', intervalMs: 60_000,
            });
            testDb.sqlite.query(`
                UPDATE task_templates SET enabled = 0, next_run_at = NULL WHERE id = ?
            `).run(tmpl.id);

            expect(await initializeNextRunAt(tmpl.id)).toBeNull();
            expect((await TaskTemplateService.getById(tmpl.id))?.nextRunAt).toBeNull();
        });
    });

    describe('enable', () => {
        test('重新启用已触发 delayed 模板时立即恢复原到期点，触发后再次禁用', async () => {
            const runAt = Date.now() - 1_000;
            const tmpl = await TaskTemplateService.create({
                name: '重新启用 delayed', agent: 'a', prompt: 'p',
                scheduleType: 'delayed', runAt,
            });
            expect(await cloneTaskFromTemplate(tmpl.id)).not.toBeNull();
            expect((await TaskTemplateService.getById(tmpl.id))?.enabled).toBe(false);

            const enabled = await TaskTemplateService.enable(tmpl.id);
            expect(enabled?.enabled).toBe(true);
            expect(enabled?.nextRunAt).toBe(runAt);
            expect((await getDueTemplates()).map((template) => template.id)).toContain(tmpl.id);

            const firstTask = (await TaskService.list({ limit: 1 }))[0];
            await TaskService.start(firstTask.id);
            await TaskService.done(firstTask.id);
            expect(await cloneTaskFromTemplate(tmpl.id)).not.toBeNull();
            const after = await TaskTemplateService.getById(tmpl.id);
            expect(after?.enabled).toBe(false);
            expect(after?.nextRunAt).toBeNull();
        });
    });
});
