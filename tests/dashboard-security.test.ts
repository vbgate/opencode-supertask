import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'fs';
import { eq } from 'drizzle-orm';
import { setupTestDb } from './helpers/mock-db';
import dashboardServer, {
    dashboardApp,
    isSafeDashboardRestartTarget,
    presentRunLog,
    resolveDashboardConfigState,
} from '../src/web/index';
import { resolveEditedRunAt } from '../src/web/ui';
import { TaskService } from '../src/core/services/task.service';
import { TaskRunService } from '../src/core/services/task-run.service';
import { TaskTemplateService } from '../src/core/services/task-template.service';
import {
    initializeGatewayHealth,
    markGatewayFailure,
    markGatewaySuccess,
    resetGatewayHealth,
} from '../src/gateway/health';

describe('Dashboard 安全边界', () => {
    let testDb: ReturnType<typeof setupTestDb>;
    const maintenanceBackups: string[] = [];

    beforeEach(() => {
        testDb = setupTestDb();
        resetGatewayHealth();
    });

    test('独立 Dashboard 默认只监听回环地址', () => {
        expect(dashboardServer.hostname).toBe('127.0.0.1');
    });

    test('Dashboard 支持中英文协商、显式切换和持久化主题控件', async () => {
        const chinese = await (await dashboardApp.request('http://localhost/')).text();
        expect(chinese).toContain('<html lang="zh-CN">');
        expect(chinese).toContain('任务队列');
        expect(chinese).toContain('id="theme-select"');
        expect(chinese).toContain('value="system"');
        expect(chinese).toContain('value="light"');
        expect(chinese).toContain('value="dark"');
        expect(chinese).toContain("localStorage.getItem('supertask-theme')");
        expect(chinese).toContain('class="skip-link"');
        expect(chinese).toContain('name="viewport"');

        const englishCookie = await (await dashboardApp.request('http://localhost/', {
            headers: { Cookie: 'supertask_locale=en' },
        })).text();
        expect(englishCookie).toContain('<html lang="en">');
        expect(englishCookie).toContain('Task queue');
        expect(englishCookie).toContain('<span>System</span>');

        const englishHeader = await (await dashboardApp.request('http://localhost/templates', {
            headers: { 'Accept-Language': 'en-US,en;q=0.9' },
        })).text();
        expect(englishHeader).toContain('<html lang="en">');
        expect(englishHeader).toContain('Scheduled tasks');

        const queryOverride = await (await dashboardApp.request('http://localhost/runs?lang=zh-CN', {
            headers: { Cookie: 'supertask_locale=en' },
        })).text();
        expect(queryOverride).toContain('<html lang="zh-CN">');
        expect(queryOverride).toContain('执行记录');
    });

    test('任务首页按项目汇总，并可从网页创建带模型和优先级的普通任务', async () => {
        const createdResponse = await dashboardApp.request('http://localhost/api/tasks', {
            method: 'POST',
            headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: '网页普通任务',
                cwd: process.cwd(),
                agent: 'build',
                model: 'openai/gpt-5',
                prompt: '执行真实项目检查',
                category: 'review',
                batchId: 'project-review',
                importance: 5,
                urgency: 4,
                maxRetries: 2,
                retryBackoff: '10s',
                timeout: '15min',
            }),
        });
        expect(createdResponse.status).toBe(201);
        const createdBody = await createdResponse.json() as { task: { id: number } };
        expect(await TaskService.getById(createdBody.task.id)).toMatchObject({
            cwd: process.cwd(),
            model: 'openai/gpt-5',
            importance: 5,
            urgency: 4,
            retryBackoffMs: 10_000,
            timeoutMs: 900_000,
        });

        const updatedResponse = await dashboardApp.request(
            `http://localhost/api/tasks/${createdBody.task.id}`,
            {
                method: 'PUT',
                headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: '网页普通任务（已编辑）',
                    cwd: process.cwd(),
                    agent: 'review',
                    model: 'anthropic/claude-sonnet-4',
                    prompt: '使用修改后的模型和优先级',
                    category: 'review',
                    batchId: '',
                    importance: 2,
                    urgency: 5,
                    maxRetries: 1,
                    retryBackoff: '20s',
                    timeout: '',
                }),
            },
        );
        expect(updatedResponse.status).toBe(200);
        expect(await TaskService.getById(createdBody.task.id)).toMatchObject({
            model: 'anthropic/claude-sonnet-4', prompt: '使用修改后的模型和优先级',
            importance: 2, urgency: 5, batchId: null, maxRetries: 1,
            retryBackoffMs: 20_000, timeoutMs: null, cwd: process.cwd(),
        });

        const otherProject = await TaskService.add({
            name: '另一个项目运行中', agent: 'build', prompt: '运行', cwd: '/tmp',
        });
        await TaskService.start(otherProject.id);

        const html = await (await dashboardApp.request('http://localhost/')).text();
        expect(html).toContain('项目分组');
        expect(html).toContain('id="task-dialog"');
        expect(html).toContain('id="task-project-status"');
        expect(html).toContain('id="task-cwd-picker"');
        expect(html).toContain('id="task-agent" required><option');
        expect(html).toContain('id="task-model-provider"');
        expect(html).toContain('id="task-model" required');
        expect(html).toContain('跟随 Agent / OpenCode 默认模型');
        expect(html).toContain("fetch('/api/opencode/catalog?cwd='");
        expect(html).toContain('id="task-timeout-preset"');
        expect(html).toContain('使用 Gateway 默认超时');
        expect(html).not.toContain('id="task-timeout" autocomplete="off"');
        expect(html).toContain('function updateTaskProjectStatus()');
        expect(html).toContain(`openTaskEditor(${createdBody.task.id})`);
        expect(html).toContain('taskField(\'cwd\').readOnly=true');
        expect(html).toContain('运行 1 · 排队 0 · 异常 0');
        expect(html).toContain(encodeURIComponent(process.cwd()));
        const projectDataMatch = html.match(/<script type="application\/json" id="task-project-data">([^<]+)<\/script>/);
        expect(projectDataMatch).not.toBeNull();
        const projectData = JSON.parse(projectDataMatch![1]) as Record<string, {
            total: number;
            pending: number;
            running: number;
            failed: number;
        }>;
        expect(projectData[process.cwd()]).toMatchObject({ pending: 1, running: 0, failed: 0 });
        expect(projectData['/tmp']).toMatchObject({ pending: 0, running: 1, failed: 0 });
        expect(html).toContain('相同非空批次 ID 的任务严格串行');
        expect(html).toContain("encodeURIComponent(data.task.cwd||'')");

        const invalidDirectory = await dashboardApp.request('http://localhost/api/tasks', {
            method: 'POST',
            headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: '错误目录', cwd: `${process.cwd()}/package.json`, agent: 'build', prompt: '不会入队',
            }),
        });
        expect(invalidDirectory.status).toBe(400);
        expect((await invalidDirectory.json() as { error: string }).error).toContain('不是目录');

        const runningEdit = await dashboardApp.request(
            `http://localhost/api/tasks/${otherProject.id}`,
            {
                method: 'PUT',
                headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: '不能修改', cwd: '/tmp', agent: 'build', model: 'default',
                    prompt: '运行中', importance: 3, urgency: 3, maxRetries: 3,
                    retryBackoff: '30s', timeout: '',
                }),
            },
        );
        expect(runningEdit.status).toBe(409);

        const directories = await dashboardApp.request(
            `http://localhost/api/filesystem/directories?path=${encodeURIComponent(process.cwd())}`,
        );
        expect(directories.status).toBe(200);
        expect(await directories.json()).toMatchObject({ path: process.cwd() });
    });

    test('项目视图覆盖数百任务规模，并为旧版无目录任务提供未分组入口', async () => {
        const inserted = await testDb.db.insert(testDb.schema.tasks).values([
            ...Array.from({ length: 101 }, (_, index) => ({
                name: `项目任务 ${index}`,
                agent: 'build',
                prompt: '检查项目',
                cwd: `/tmp/supertask-project-${index}`,
            })),
            { name: '旧版未分组', agent: 'build', prompt: '兼容旧数据', cwd: null },
        ]).returning();
        const legacyTask = inserted.find((task) => task.cwd === null);
        if (!legacyTask) throw new Error('未创建旧版无目录任务');

        const html = await (await dashboardApp.request('http://localhost/')).text();
        const projectDataMatch = html.match(/<script type="application\/json" id="task-project-data">([^<]+)<\/script>/);
        expect(projectDataMatch).not.toBeNull();
        const projectData = JSON.parse(projectDataMatch![1]) as Record<string, unknown>;
        expect(Object.keys(projectData)).toHaveLength(101);
        expect(projectData['/tmp/supertask-project-0']).toBeDefined();
        expect(html).toContain('未分组');
        expect(html).toContain('旧版本中没有项目目录的任务');

        const legacyHtml = await (await dashboardApp.request(
            'http://localhost/?cwd=__supertask_legacy__',
        )).text();
        expect(legacyHtml).toContain('旧版未分组');
        expect(legacyHtml).not.toContain('项目任务 100');
        expect(legacyHtml).not.toContain(`openTaskEditor(${legacyTask.id})`);
        expect(legacyHtml).toContain(`cancelTask(${legacyTask.id})`);
    });

    test('运行中视图包含已取消但进程尚未退出的任务，并明确提示占用并发', async () => {
        const task = await TaskService.add({
            name: '正在停止的网页任务',
            agent: 'build',
            prompt: '等待进程树退出',
            cwd: process.cwd(),
        });
        await TaskService.start(task.id);
        const run = await TaskRunService.create({ taskId: task.id, status: 'running' });
        await TaskService.cancel(task.id);

        const url = `http://localhost/?status=running&cwd=${encodeURIComponent(process.cwd())}`;
        const activeHtml = await (await dashboardApp.request(url)).text();
        expect(activeHtml).toContain('正在停止的网页任务');
        expect(activeHtml).toContain('执行进程仍在退出，暂时占用并发');
        expect(activeHtml).toContain('<div class="stat-value">1</div><div class="stat-label">运行中</div>');
        expect(activeHtml).toContain('第 1 页，共 1 页 · 1 条');

        await TaskRunService.fail(run.id, '进程树已退出');
        const stoppedHtml = await (await dashboardApp.request(url)).text();
        expect(stoppedHtml).not.toContain('正在停止的网页任务');
        expect(stoppedHtml).toContain('<div class="stat-value">0</div><div class="stat-label">运行中</div>');
        expect(stoppedHtml).toContain('第 1 页，共 1 页 · 0 条');
    });

    test('定时任务页面可创建和编辑完整执行配置', async () => {
        const html = await (await dashboardApp.request('http://localhost/templates')).text();
        expect(html).toContain('定时任务');
        expect(html).toContain('新建定时任务');
        expect(html).toContain('id="template-dialog"');
        expect(html).toContain('id="template-model"');
        expect(html).toContain('id="template-interval-preset"');
        expect(html).toContain('每 1 小时');
        expect(html).toContain('id="template-cwd"');
        expect(html).toContain("openDirectoryPicker('template-cwd')");
        expect(html).toContain('id="template-prompt"');
        expect(html).toContain('type="datetime-local" step="0.001"');
        expect(html).toContain("toISOString().slice(0,23)");
        expect(html).toContain('resolveEditedRunAt(input.dataset.originalEpoch?Number(input.dataset.originalEpoch):null');
        expect(html).toContain("status.pid!==data.previousPid&&status.managed&&status.ready&&!status.restartRequired");
        expect(html).toContain('if(restartAfterSave&&!await confirmGatewayRestart(runningCount))return');
        expect(html).toContain("location.assign(id?location.href:'/templates')");
        expect(html).not.toContain('supertask template add');

        const input = {
            name: '网页定时任务',
            cwd: process.cwd(),
            agent: 'build',
            model: 'openai/gpt-5',
            prompt: '检查项目并生成报告',
            scheduleType: 'recurring',
            cronExpr: '',
            interval: '5min',
            runAt: null,
            category: 'maintenance',
            batchId: 'daily',
            importance: 4,
            urgency: 2,
            maxInstances: 2,
            maxRetries: 5,
            retryBackoff: '10s',
            timeout: '15min',
        };
        const createdResponse = await dashboardApp.request('http://localhost/api/templates', {
            method: 'POST',
            headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' },
            body: JSON.stringify(input),
        });
        expect(createdResponse.status).toBe(201);
        const createdBody = await createdResponse.json() as { template: { id: number } };
        const created = await TaskTemplateService.getById(createdBody.template.id);
        expect(created).toMatchObject({
            model: 'openai/gpt-5',
            prompt: '检查项目并生成报告',
            cwd: process.cwd(),
            intervalMs: 300_000,
            retryBackoffMs: 10_000,
            timeoutMs: 900_000,
        });

        const updatedResponse = await dashboardApp.request(
            `http://localhost/api/templates/${createdBody.template.id}`,
            {
                method: 'PUT',
                headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ...input,
                    model: 'anthropic/claude-sonnet-4',
                    prompt: '使用更新后的提示词',
                    scheduleType: 'cron',
                    cronExpr: '0 8 * * *',
                    interval: '',
                }),
            },
        );
        expect(updatedResponse.status).toBe(200);
        const updated = await TaskTemplateService.getById(createdBody.template.id);
        expect(updated).toMatchObject({
            model: 'anthropic/claude-sonnet-4',
            prompt: '使用更新后的提示词',
            scheduleType: 'cron',
            cronExpr: '0 8 * * *',
            intervalMs: null,
        });

        const invalid = await dashboardApp.request('http://localhost/api/templates', {
            method: 'POST',
            headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...input, prompt: '' }),
        });
        expect(invalid.status).toBe(400);

        for (const interval of ['1', '+1', '0x1', '1e3']) {
            const unitlessInterval = await dashboardApp.request('http://localhost/api/templates', {
                method: 'POST',
                headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...input, interval }),
            });
            expect(unitlessInterval.status).toBe(400);
            expect((await unitlessInterval.json() as { error: string }).error).toContain('必须带时间单位');
        }
    });

    test('立即运行无视模板最大实例限制并持续加入任务队列', async () => {
        const template = await TaskTemplateService.create({
            name: '网页手动入队',
            agent: 'build',
            prompt: '立即执行',
            scheduleType: 'recurring',
            intervalMs: 60_000,
            maxInstances: 1,
        });

        const first = await dashboardApp.request(
            `http://localhost/api/templates/${template.id}/trigger`,
            { method: 'POST', headers: { Origin: 'http://localhost' } },
        );
        const second = await dashboardApp.request(
            `http://localhost/api/templates/${template.id}/trigger`,
            { method: 'POST', headers: { Origin: 'http://localhost' } },
        );

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        const firstBody = await first.json() as { taskId: number };
        const secondBody = await second.json() as { taskId: number };
        expect(secondBody.taskId).not.toBe(firstBody.taskId);
        expect(await TaskService.getById(firstBody.taskId)).toMatchObject({
            status: 'pending',
            templateId: template.id,
        });
        expect(await TaskService.getById(secondBody.taskId)).toMatchObject({
            status: 'pending',
            templateId: template.id,
        });
    });

    test('一次性任务只编辑提示词时保留 DST 重叠时刻的原始时间戳', () => {
        const originalEpoch = Date.parse('2026-11-01T06:30:00.123Z');
        const repeatedLocalTime = '2026-11-01T01:30:00.123';
        expect(resolveEditedRunAt(
            originalEpoch,
            repeatedLocalTime,
            repeatedLocalTime,
        )).toBe(originalEpoch);
    });

    test('定时任务列表分页覆盖全部记录并纠正越界页', async () => {
        for (let index = 1; index <= 51; index += 1) {
            await TaskTemplateService.create({
                name: `定时任务-${String(index).padStart(3, '0')}`,
                agent: 'build',
                prompt: '测试分页',
                scheduleType: 'cron',
                cronExpr: '0 9 * * *',
            });
        }

        const firstPage = await (await dashboardApp.request('http://localhost/templates')).text();
        const secondPage = await (await dashboardApp.request('http://localhost/templates?page=2')).text();
        expect(firstPage).toContain('定时任务-051');
        expect(firstPage).not.toContain('定时任务-001');
        expect(secondPage).toContain('定时任务-001');
        expect(await TaskTemplateService.stats()).toEqual({ total: 51, enabled: 51, disabled: 0 });

        const outOfRange = await dashboardApp.request('http://localhost/templates?page=99');
        expect(outOfRange.status).toBe(302);
        expect(outOfRange.headers.get('Location')).toBe('/templates?page=2');
    });

    test('任务页和执行记录页可安全复制 OpenCode 会话命令', async () => {
        const task = await TaskService.add({ name: '可继续会话', agent: 'build', prompt: '继续测试' });
        await TaskService.start(task.id);
        const run = await TaskRunService.create({ taskId: task.id, status: 'running' });
        await TaskRunService.updateSessionId(run.id, 'ses_abc123XYZ');
        await TaskRunService.done(run.id, 'ok');
        await TaskService.done(task.id, 'ok');

        const tasksHtml = await (await dashboardApp.request('http://localhost/')).text();
        const runsHtml = await (await dashboardApp.request('http://localhost/runs')).text();
        expect(tasksHtml).toContain(`copySessionCommand(${run.id})`);
        expect(runsHtml).toContain(`copySessionCommand(${run.id})`);
        expect(runsHtml).toContain('abc***XYZ');
        expect(tasksHtml).not.toContain('ses_abc123XYZ');
        expect(runsHtml).not.toContain('ses_abc123XYZ');
        expect(runsHtml).toContain(`id="log-${run.id}" class="run-log-row" hidden`);
        expect(runsHtml.indexOf(`id="log-${run.id}"`)).toBeLessThan(runsHtml.indexOf('</tbody>'));

        const commandResponse = await dashboardApp.request(
            `http://localhost/api/runs/${run.id}/session-command`,
        );
        expect(commandResponse.status).toBe(200);
        expect(await commandResponse.json()).toEqual({
            command: 'opencode --session ses_abc123XYZ',
        });
    });

    test('详情默认展示语义化字段，原始 JSON 收进二级入口', async () => {
        const task = await TaskService.add({ name: '人类详情', agent: 'build', prompt: '测试详情' });
        await TaskService.start(task.id);
        const run = await TaskRunService.create({ taskId: task.id, status: 'running' });
        await TaskService.completeRun(task.id, run.id, JSON.stringify({
            type: 'text', part: { type: 'text', text: '人类可读结果' },
        }));
        const detail = await (await dashboardApp.request(`http://localhost/api/tasks/${task.id}`)).json() as {
            _resultPresentation: { text: string };
        };
        const html = await (await dashboardApp.request('http://localhost/')).text();
        const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
        expect(detail._resultPresentation.text).toBe('人类可读结果');
        expect(() => new Function(scripts.at(-1)?.[1] ?? '')).not.toThrow();
        expect(html).toContain('id="detail-content" class="detail-view"');
        expect(html).toContain('class="detail-raw"');
        expect(html).toContain('id="detail-raw" class="json-view"');
        expect(html).toContain("detailFields(type,data)");
        expect(html).not.toContain('<pre id="detail-content"');
        expect(html).toContain('重点信息已整理；原始数据仅用于排障。');
    });

    test('执行日志提取模型文本、失败原因和实际命令，同时保留原始日志', () => {
        const command = JSON.stringify({
            type: 'supertask_command',
            executable: '/opt/Open Code/opencode',
            cwd: '/tmp/project with space',
            args: ['run', '--agent', 'build', '--format', 'json', '-m', 'openai/gpt-5', 'say "hi"'],
        });
        const output = JSON.stringify({
            type: 'text',
            part: { type: 'text', text: '任务完成' },
        });
        const presented = presentRunLog(`opencode 退出码 1\n${command}\n${output}`);

        expect(presented.command).toEqual({
            cwd: '/tmp/project with space',
            command: "cd '/tmp/project with space' && '/opt/Open Code/opencode' run --agent build --format json -m openai/gpt-5 'say \"hi\"'",
        });
        expect(presented.text).toBe('任务完成');
        expect(presented.errors).toEqual(['opencode 退出码 1']);
    });

    test('异常 Session ID 不生成终端命令', async () => {
        const task = await TaskService.add({ name: '异常会话', agent: 'a', prompt: 'p' });
        const run = await TaskRunService.create({ taskId: task.id, status: 'running' });
        await testDb.db.update(testDb.schema.taskRuns)
            .set({ sessionId: 'ses_ok; touch /tmp/injected' })
            .where(eq(testDb.schema.taskRuns.id, run.id));

        const html = await (await dashboardApp.request('http://localhost/')).text();
        expect(html).not.toContain(`copySessionCommand(${run.id})`);
        expect(html).not.toContain('touch /tmp/injected');

        const response = await dashboardApp.request(
            `http://localhost/api/runs/${run.id}/session-command`,
        );
        expect(response.status).toBe(409);
    });

    test('面向人的状态文案解释等待重试和停止状态', async () => {
        const failed = await TaskService.add({ name: '等待任务', agent: 'a', prompt: 'p' });
        const stopped = await TaskService.add({ name: '停止任务', agent: 'a', prompt: 'p' });
        await TaskService.start(failed.id);
        const failedRun = await TaskRunService.create({ taskId: failed.id, status: 'running' });
        await TaskRunService.fail(failedRun.id, '本次执行失败');
        await TaskService.fail(failed.id, '等待自动重试');
        await testDb.db.update(testDb.schema.tasks).set({ status: 'dead_letter' })
            .where(eq(testDb.schema.tasks.id, stopped.id));

        const html = await (await dashboardApp.request('http://localhost/')).text();
        const runsHtml = await (await dashboardApp.request('http://localhost/runs')).text();
        expect(html).toContain('等待重试');
        expect(html).toContain('已停止');
        expect(html).toContain('系统不会再自动运行');
        expect(html).not.toContain('>死信<');
        expect(runsHtml).toContain('<span class="badge b-failed">失败</span>');
    });

    test('Dashboard 使用自定义确认对话框，清库仍要求输入 CLEAR', async () => {
        const html = await (await dashboardApp.request('http://localhost/system')).text();
        expect(html).toContain('id="confirm-dialog"');
        expect(html).toContain('id="danger-dialog"');
        expect(html).toContain('id="danger-confirmation"');
        expect(html).toContain("this.value!=='CLEAR'");
        expect(html).not.toContain("confirm('");
        expect(html).not.toContain("alert('");
    });

    test('网页重启只接受 PID、ready 锁和运行作用域全部匹配的 PM2 进程', () => {
        const scope = {
            cwd: '/tmp/project',
            databasePath: '/tmp/tasks.db',
            configPath: '/tmp/config.json',
            opencodePath: '/usr/local/bin/opencode',
            home: '/tmp/home',
            pm2Home: '/tmp/pm2',
            managementLockPath: '/tmp/pm2/manage.sqlite',
        };
        const diagnostic = {
            pm2Installed: true,
            processFound: true,
            status: 'online',
            pid: 42,
            ready: true,
            runningVersion: '1.0.0',
            gatewayEntry: '/tmp/project/dist/gateway/index.js',
            gatewayPackageVersion: '1.0.0',
            logRotationInstalled: true,
            startupConfigured: true,
            currentScope: scope,
            gatewayScope: scope,
            scopeMatches: true,
        };

        expect(isSafeDashboardRestartTarget(diagnostic, 42)).toBe(true);
        expect(isSafeDashboardRestartTarget({ ...diagnostic, pid: 43 }, 42)).toBe(false);
        expect(isSafeDashboardRestartTarget({ ...diagnostic, ready: false }, 42)).toBe(false);
        expect(isSafeDashboardRestartTarget({ ...diagnostic, scopeMatches: false }, 42)).toBe(false);
        expect(isSafeDashboardRestartTarget({ ...diagnostic, status: 'stopped' }, 42)).toBe(false);

        expect(resolveDashboardConfigState(true, true, false)).toBe('manual');
        expect(resolveDashboardConfigState(true, true, true)).toBe('pending');
        expect(resolveDashboardConfigState(true, false, false)).toBe('applied');
        expect(resolveDashboardConfigState(false, true, false)).toBe('foreground');
    });

    afterEach(() => {
        for (const path of maintenanceBackups.splice(0)) {
            rmSync(path, { force: true });
        }
    });

    test('拒绝跨站写请求，但允许同源 Dashboard 请求', async () => {
        const task = await TaskService.add({ name: '待删除任务', agent: 'a', prompt: 'p' });

        const blocked = await dashboardApp.request(`http://localhost/api/tasks/${task.id}`, {
            method: 'DELETE',
            headers: { Origin: 'https://evil.example' },
        });
        expect(blocked.status).toBe(403);
        expect(blocked.headers.get('X-Frame-Options')).toBe('DENY');
        expect(await TaskService.getById(task.id)).not.toBeNull();

        const allowed = await dashboardApp.request(`http://localhost/api/tasks/${task.id}`, {
            method: 'DELETE',
            headers: { Origin: 'http://localhost' },
        });
        expect(allowed.status).toBe(200);
        expect(await TaskService.getById(task.id)).toBeNull();
    });

    test('运行中任务必须先取消，不能从 Dashboard 直接删除', async () => {
        const task = await TaskService.add({ name: '运行中任务', agent: 'a', prompt: 'p' });
        await TaskService.start(task.id);
        await TaskRunService.create({ taskId: task.id, status: 'running' });

        const blocked = await dashboardApp.request(`http://localhost/api/tasks/${task.id}`, {
            method: 'DELETE',
            headers: { Origin: 'http://localhost' },
        });
        expect(blocked.status).toBe(409);
        expect((await blocked.json() as { error: string }).error).toContain('请先取消任务');

        const cancelled = await dashboardApp.request(`http://localhost/api/tasks/${task.id}/cancel`, {
            method: 'POST',
            headers: { Origin: 'http://localhost' },
        });
        expect(cancelled.status).toBe(200);
        expect((await TaskService.getById(task.id))?.status).toBe('cancelled');

        const cancellingHtml = await (await dashboardApp.request('http://localhost/')).text();
        expect(cancellingHtml).not.toContain(`onclick="deleteTask(${task.id})"`);

        const stillRunning = await dashboardApp.request(`http://localhost/api/tasks/${task.id}`, {
            method: 'DELETE',
            headers: { Origin: 'http://localhost' },
        });
        expect(stillRunning.status).toBe(409);
    });

    test('任务、模板和日志字符串在 HTML 中完整转义', async () => {
        const task = await TaskService.add({
            name: '<img src=x onerror=alert(1)>',
            agent: 'a',
            prompt: 'p',
        });
        await TaskService.start(task.id);
        const run = await TaskRunService.create({ taskId: task.id, status: 'running' });
        await TaskRunService.fail(run.id, '<script>alert("日志")</script> &');

        const tmpl = await TaskTemplateService.create({
            name: '模板',
            agent: 'a',
            prompt: 'p',
            scheduleType: 'cron',
            cronExpr: '0 9 * * *',
        });
        await testDb.db.update(testDb.schema.taskTemplates)
            .set({ cronExpr: '<svg onload=alert(2)>' })
            .where(eq(testDb.schema.taskTemplates.id, tmpl.id));

        const runsHtml = await (await dashboardApp.request('http://localhost/runs')).text();
        const templatesHtml = await (await dashboardApp.request('http://localhost/templates')).text();
        expect(runsHtml).not.toContain('<img src=x onerror=alert(1)>');
        expect(runsHtml).not.toContain('<script>alert("日志")</script>');
        expect(runsHtml).toContain('&lt;script&gt;alert(&quot;日志&quot;)&lt;/script&gt; &amp;');
        expect(templatesHtml).not.toContain('<svg onload=alert(2)>');
        expect(templatesHtml).toContain('&lt;svg onload=alert(2)&gt;');
    });

    test('非法 ID 和非法配置返回 400', async () => {
        const invalidId = await dashboardApp.request('http://localhost/api/tasks/not-a-number');
        expect(invalidId.status).toBe(400);

        const invalidConfig = await dashboardApp.request('http://localhost/api/config', {
            method: 'PUT',
            headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' },
            body: JSON.stringify({ worker: { maxConcurrency: 0 } }),
        });
        expect(invalidConfig.status).toBe(400);

        const invalidSection = await dashboardApp.request('http://localhost/api/config', {
            method: 'PUT',
            headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' },
            body: JSON.stringify({ worker: 5 }),
        });
        expect(invalidSection.status).toBe(400);

        const missingRestartConfirmation = await dashboardApp.request(
            'http://localhost/api/gateway/restart',
            {
                method: 'POST',
                headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            },
        );
        expect(missingRestartConfirmation.status).toBe(400);

        const nullRestartConfirmation = await dashboardApp.request(
            'http://localhost/api/gateway/restart',
            {
                method: 'POST',
                headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' },
                body: 'null',
            },
        );
        expect(nullRestartConfirmation.status).toBe(400);

        const unmanagedRestart = await dashboardApp.request('http://localhost/api/gateway/restart', {
            method: 'POST',
            headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' },
            body: JSON.stringify({ confirmation: 'RESTART' }),
        });
        expect(unmanagedRestart.status).toBe(409);

        const gatewayStatus = await dashboardApp.request('http://localhost/api/gateway/status');
        expect(await gatewayStatus.json()).toMatchObject({ managed: false, ready: false });
    });

    test('清空数据库需要服务端确认、拒绝运行中任务并生成可恢复备份', async () => {
        const task = await TaskService.add({ name: '数据库维护任务', agent: 'a', prompt: 'p' });
        await TaskTemplateService.create({
            name: '数据库维护模板',
            agent: 'a',
            prompt: 'p',
            scheduleType: 'cron',
            cronExpr: '0 9 * * *',
        });

        const missingConfirmation = await dashboardApp.request('http://localhost/api/database/clear', {
            method: 'POST',
            headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        expect(missingConfirmation.status).toBe(400);
        expect(await TaskService.getById(task.id)).not.toBeNull();

        await TaskService.start(task.id);
        const running = await dashboardApp.request('http://localhost/api/database/clear', {
            method: 'POST',
            headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' },
            body: JSON.stringify({ confirmation: 'CLEAR' }),
        });
        expect(running.status).toBe(409);
        expect(await TaskService.getById(task.id)).not.toBeNull();

        await TaskService.done(task.id, '测试完成');
        const now = Date.now();
        testDb.sqlite.exec(`
            CREATE TABLE future_dashboard_state (
                id INTEGER PRIMARY KEY,
                value TEXT
            );
            INSERT INTO future_dashboard_state VALUES (1, 'must-be-cleared');
        `);
        testDb.sqlite.query(
            'INSERT INTO gateway_lock (id, pid, acquired_at, heartbeat_at, ready_at) VALUES (1, ?, ?, ?, ?)',
        ).run(process.pid, now, now, now);
        const cleared = await dashboardApp.request('http://localhost/api/database/clear', {
            method: 'POST',
            headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' },
            body: JSON.stringify({ confirmation: 'CLEAR' }),
        });
        expect(cleared.status).toBe(200);
        const body = await cleared.json() as {
            success: boolean;
            backupPath: string;
            deleted: { tasks: number; taskRuns: number; taskTemplates: number };
        };
        maintenanceBackups.push(body.backupPath);
        expect(body.success).toBe(true);
        expect(body.deleted.tasks).toBe(1);
        expect(body.deleted.taskTemplates).toBe(1);
        expect(await TaskService.getById(task.id)).toBeNull();
        expect(await TaskTemplateService.list()).toHaveLength(0);
        expect((testDb.sqlite.query('SELECT COUNT(*) AS count FROM future_dashboard_state')
            .get() as { count: number }).count).toBe(0);
        expect((testDb.sqlite.query('SELECT pid FROM gateway_lock WHERE id = 1')
            .get() as { pid: number }).pid).toBe(process.pid);
    });

    test('健康检查同时要求组件活跃和匹配当前进程的 ready 锁', async () => {
        initializeGatewayHealth({
            workerPollIntervalMs: 1000,
            schedulerEnabled: true,
            schedulerCheckIntervalMs: 1000,
            watchdogCheckIntervalMs: 60_000,
            watchdogCleanupIntervalMs: 86_400_000,
        });

        const unhealthy = await dashboardApp.request('http://localhost/health');
        expect(unhealthy.status).toBe(503);

        const now = Date.now();
        testDb.sqlite.query(
            'INSERT INTO gateway_lock (id, pid, acquired_at, heartbeat_at, ready_at) VALUES (1, ?, ?, ?, ?)',
        ).run(process.pid, now, now, now);

        const healthy = await dashboardApp.request('http://localhost/health');
        expect(healthy.status).toBe(200);
        const body = await healthy.json() as { status: string; lock: { pid: number } };
        expect(body.status).toBe('ok');
        expect(body.lock.pid).toBe(process.pid);
    });

    test('组件连续失败会降级，下一次成功后恢复并保留最近错误', async () => {
        initializeGatewayHealth({
            workerPollIntervalMs: 1000,
            schedulerEnabled: true,
            schedulerCheckIntervalMs: 1000,
            watchdogCheckIntervalMs: 60_000,
            watchdogCleanupIntervalMs: 86_400_000,
        });
        const now = Date.now();
        testDb.sqlite.query(
            'INSERT INTO gateway_lock (id, pid, acquired_at, heartbeat_at, ready_at) VALUES (1, ?, ?, ?, ?)',
        ).run(process.pid, now, now, now);

        markGatewayFailure('worker', new Error('database busy'));
        const degraded = await dashboardApp.request('http://localhost/health');
        expect(degraded.status).toBe(503);
        const degradedBody = await degraded.json() as {
            components: { worker: { consecutiveFailures: number; lastError: { message: string } } };
        };
        expect(degradedBody.components.worker.consecutiveFailures).toBe(1);
        expect(degradedBody.components.worker.lastError.message).toBe('database busy');

        markGatewaySuccess('worker');
        const recovered = await dashboardApp.request('http://localhost/health');
        expect(recovered.status).toBe(200);
        const recoveredBody = await recovered.json() as {
            components: { worker: { consecutiveFailures: number; lastError: { message: string } } };
        };
        expect(recoveredBody.components.worker.consecutiveFailures).toBe(0);
        expect(recoveredBody.components.worker.lastError.message).toBe('database busy');
    });

    test('清理失败不会被心跳检查成功洗绿', async () => {
        initializeGatewayHealth({
            workerPollIntervalMs: 1000,
            schedulerEnabled: true,
            schedulerCheckIntervalMs: 1000,
            watchdogCheckIntervalMs: 60_000,
            watchdogCleanupIntervalMs: 86_400_000,
        });
        const now = Date.now();
        testDb.sqlite.query(
            'INSERT INTO gateway_lock (id, pid, acquired_at, heartbeat_at, ready_at) VALUES (1, ?, ?, ?, ?)',
        ).run(process.pid, now, now, now);

        markGatewayFailure('watchdogCleanup', new Error('cleanup failed'));
        markGatewaySuccess('watchdog');
        const degraded = await dashboardApp.request('http://localhost/health');
        expect(degraded.status).toBe(503);

        markGatewaySuccess('watchdogCleanup');
        const recovered = await dashboardApp.request('http://localhost/health');
        expect(recovered.status).toBe(200);
    });
});
