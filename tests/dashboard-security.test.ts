import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'fs';
import { eq } from 'drizzle-orm';
import { setupTestDb } from './helpers/mock-db';
import dashboardServer, { dashboardApp } from '../src/web/index';
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
        expect(englishHeader).toContain('Schedule templates');

        const queryOverride = await (await dashboardApp.request('http://localhost/runs?lang=zh-CN', {
            headers: { Cookie: 'supertask_locale=en' },
        })).text();
        expect(queryOverride).toContain('<html lang="zh-CN">');
        expect(queryOverride).toContain('执行记录');
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
