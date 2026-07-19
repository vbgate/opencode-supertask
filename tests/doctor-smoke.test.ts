import { beforeEach, describe, expect, test } from 'bun:test';
import { setupTestDb } from './helpers/mock-db';
import { runDoctorSmoke } from '../src/cli/doctor-smoke';
import { TaskService } from '../src/core/services/task.service';
import { TaskRunService } from '../src/core/services/task-run.service';

describe('doctor real smoke task', () => {
    beforeEach(() => {
        setupTestDb();
    });

    test('只有 Gateway 完成任务且返回预期标记才通过', async () => {
        const marker = 'SUPERTASK_SMOKE_TEST_OK';
        const pendingResult = runDoctorSmoke({
            agent: 'build',
            model: 'openai/test-model',
            variant: 'xhigh',
            cwd: process.cwd(),
            timeoutMs: 2_000,
            marker,
            pollIntervalMs: 10,
        });

        let task = (await TaskService.list({ category: 'diagnostic' }))[0];
        while (!task) {
            await Bun.sleep(5);
            task = (await TaskService.list({ category: 'diagnostic' }))[0];
        }
        await TaskService.start(task.id);
        const run = await TaskRunService.create({
            taskId: task.id,
            model: task.model,
            variant: task.variant,
            status: 'running',
        });
        await TaskService.completeRun(task.id, run.id, JSON.stringify({
            type: 'text',
            part: { type: 'text', text: marker },
        }));

        expect(await pendingResult).toMatchObject({
            ok: true,
            taskId: task.id,
            runId: run.id,
            status: 'done',
            agent: 'build',
            model: 'openai/test-model',
            variant: 'xhigh',
            cwd: process.cwd(),
            error: null,
        });
    });

    test('OpenCode 成功退出但输出不匹配时仍失败', async () => {
        const pendingResult = runDoctorSmoke({
            agent: 'build',
            cwd: process.cwd(),
            timeoutMs: 2_000,
            marker: 'EXPECTED_MARKER',
            pollIntervalMs: 10,
        });

        let task = (await TaskService.list({ category: 'diagnostic' }))[0];
        while (!task) {
            await Bun.sleep(5);
            task = (await TaskService.list({ category: 'diagnostic' }))[0];
        }
        await TaskService.start(task.id);
        const run = await TaskRunService.create({ taskId: task.id, status: 'running' });
        await TaskService.completeRun(task.id, run.id, JSON.stringify({
            type: 'text', part: { type: 'text', text: 'prefix EXPECTED_MARKER suffix' },
        }));

        expect(await pendingResult).toMatchObject({
            ok: false,
            taskId: task.id,
            runId: run.id,
            status: 'done',
            error: 'OpenCode 已退出成功，但模型文本不是预期的精确标记',
        });
    });
});
