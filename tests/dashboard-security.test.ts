import { beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { setupTestDb } from './helpers/mock-db';
import { dashboardApp } from '../src/web/index';
import { TaskService } from '../src/core/services/task.service';
import { TaskRunService } from '../src/core/services/task-run.service';
import { TaskTemplateService } from '../src/core/services/task-template.service';
import { initializeGatewayHealth, resetGatewayHealth } from '../src/gateway/health';

describe('Dashboard 安全边界', () => {
    let testDb: ReturnType<typeof setupTestDb>;

    beforeEach(() => {
        testDb = setupTestDb();
        resetGatewayHealth();
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

    test('健康检查同时要求组件活跃和匹配当前进程的 ready 锁', async () => {
        initializeGatewayHealth({
            workerPollIntervalMs: 1000,
            schedulerEnabled: true,
            schedulerCheckIntervalMs: 1000,
            watchdogCheckIntervalMs: 60_000,
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
});
