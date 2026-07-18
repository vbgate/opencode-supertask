import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { execSync, spawnSync } from 'child_process';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const CLI = 'bun run src/cli/index.ts';
let testDbPath: string;

function run(args: string): string {
    return execSync(`${CLI} ${args}`, {
        encoding: 'utf-8',
        timeout: 10000,
        env: { ...process.env, SUPERTASK_DB_PATH: testDbPath },
    });
}

function runJson<T>(args: string): T {
    return JSON.parse(run(args)) as T;
}

beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), 'supertask-cli-test-'));
    testDbPath = join(dir, `${randomUUID()}.db`);
});

afterAll(() => {
    if (testDbPath) {
        rmSync(dirname(testDbPath), { recursive: true, force: true });
    }
});

describe('CLI integration', () => {
    let taskId1: number;

    test('add task', () => {
        const result = runJson<{ id: number; status: string }>(
            `add --name "集成测试任务A" --agent "test-agent" --prompt "测试提示词" --importance 4 --urgency 5 --max-retries 2 --retry-backoff 5s --timeout 2min`,
        );
        expect(result.id).toBeGreaterThan(0);
        expect(result.status).toBe('created');
        taskId1 = result.id;
    });

    test('add task with batch', () => {
        const result = runJson<{ id: number; status: string }>(
            `add --name "批次任务B" --agent "test-agent" --prompt "批次测试" --batch "batch-test-001"`,
        );
        expect(result.id).toBeGreaterThan(0);
    });

    test('list tasks', () => {
        const tasks = runJson<Array<{ id: number; name: string }>>('list --limit 5');
        expect(tasks.length).toBeGreaterThan(0);
    });

    test('get task by id', () => {
        const task = runJson<{ id: number; name: string; status: string; maxRetries: number; retryBackoffMs: number; timeoutMs: number }>(`get --id ${taskId1}`);
        expect(task.id).toBe(taskId1);
        expect(task.name).toBe('集成测试任务A');
        expect(task.maxRetries).toBe(2);
        expect(task.retryBackoffMs).toBe(5000);
        expect(task.timeoutMs).toBe(120000);
    });

    test('edit pending task model and priority', () => {
        const edited = runJson<{ id: number; status: string; updated: boolean }>(
            `edit --id ${taskId1} --model "openai/gpt-5" --prompt "修改后的提示词" --importance 5 --urgency 2 --clear-batch --retry-backoff 10s --clear-timeout`,
        );
        expect(edited).toEqual({ id: taskId1, status: 'pending', updated: true });
        const task = runJson<{
            model: string; prompt: string; importance: number; urgency: number;
            batchId: string | null; retryBackoffMs: number; timeoutMs: number | null;
        }>(`get --id ${taskId1}`);
        expect(task).toMatchObject({
            model: 'openai/gpt-5', prompt: '修改后的提示词', importance: 5, urgency: 2,
            batchId: null, retryBackoffMs: 10_000, timeoutMs: null,
        });
    });

    test('next returns a pending task', () => {
        const task = runJson<{ id: number } | { id: null }>('next');
        expect(task).toBeDefined();
    });

    test('cancel task', () => {
        const added = runJson<{ id: number }>(
            `add --name "取消测试" --agent "test-agent" --prompt "取消"`,
        );
        const cancelled = runJson<{ id: number; status: string }>(`cancel --id ${added.id}`);
        expect(cancelled.status).toBe('cancelled');
    });

    test('run abandon 需要强确认并只关闭已取消的旧版无 PID run', () => {
        const added = runJson<{ id: number }>(
            'add --name "旧版隔离任务" --agent "test-agent" --prompt "人工确认恢复"',
        );
        const sqlite = new Database(testDbPath);
        let runId: number;
        try {
            sqlite.query("UPDATE tasks SET status = 'running' WHERE id = ?").run(added.id);
            const row = sqlite.query(`
                INSERT INTO task_runs (task_id, status, worker_pid, child_pid, launch_protocol)
                VALUES (?, 'running', 2147483647, NULL, NULL)
                RETURNING id
            `).get(added.id) as { id: number };
            runId = row.id;
        } finally {
            sqlite.close();
        }

        const cancelled = runJson<{ status: string }>(`cancel --id ${added.id}`);
        expect(cancelled.status).toBe('cancelled');

        const denied = spawnSync(
            'bun',
            ['run', 'src/cli/index.ts', 'run', 'abandon', '--id', String(runId)],
            {
                cwd: process.cwd(),
                encoding: 'utf8',
                env: { ...process.env, SUPERTASK_DB_PATH: testDbPath },
            },
        );
        expect(denied.status).not.toBe(0);
        expect(`${denied.stdout}${denied.stderr}`).toContain('--confirm ABANDON');

        const abandoned = runJson<{
            runId: number;
            taskId: number;
            runStatus: string;
            taskStatus: string;
        }>(`run abandon --id ${runId} --confirm ABANDON`);
        expect(abandoned).toEqual({
            runId,
            taskId: added.id,
            runStatus: 'failed',
            taskStatus: 'cancelled',
        });

        const checked = new Database(testDbPath, { readonly: true });
        try {
            const run = checked.query('SELECT status FROM task_runs WHERE id = ?').get(runId) as { status: string };
            const task = checked.query('SELECT status FROM tasks WHERE id = ?').get(added.id) as { status: string };
            expect(run.status).toBe('failed');
            expect(task.status).toBe('cancelled');
        } finally {
            checked.close();
        }
    });

    test('stats', () => {
        const stats = runJson<Record<string, number>>('status');
        expect(stats.total).toBeGreaterThan(0);
        expect(typeof stats.done).toBe('number');
    });

    test('delete task', () => {
        const added = runJson<{ id: number }>(
            `add --name "删除测试" --agent "test-agent" --prompt "删除"`,
        );
        const result = runJson<{ deleted: boolean }>(`delete --id ${added.id}`);
        expect(result.deleted).toBe(true);
    });

    test('list by status', () => {
        const tasks = runJson<Array<{ id: number }>>('list --status done --limit 10');
        expect(Array.isArray(tasks)).toBe(true);
    });
});

describe('CLI template', () => {
    let templateId: number;

    test('template add', () => {
        const result = runJson<{ id: number; status: string; nextRunAt: number | null }>(
            `template add --name "测试模板" --agent "test-agent" --prompt "定时任务" --type cron --cron "0 9 * * *" --batch "每日批次" --retry-backoff 5s --timeout 2min`,
        );
        expect(result.id).toBeGreaterThan(0);
        expect(result.status).toBe('created');
        expect(result.nextRunAt).not.toBeNull();
        templateId = result.id;
    });

    test('template list', () => {
        const templates = runJson<Array<{ id: number; cwd: string; batchId: string; retryBackoffMs: number; timeoutMs: number }>>('template list');
        expect(templates.length).toBeGreaterThan(0);
        const template = templates.find((item) => item.id === templateId)!;
        expect(template.cwd).toBe(process.cwd());
        expect(template.batchId).toBe('每日批次');
        expect(template.retryBackoffMs).toBe(5000);
        expect(template.timeoutMs).toBe(120000);
    });

    test('template disable', () => {
        const result = runJson<{ id: number; enabled: boolean }>(`template disable --id ${templateId}`);
        expect(result.enabled).toBe(false);
    });

    test('template enable', () => {
        const result = runJson<{ id: number; enabled: boolean }>(`template enable --id ${templateId}`);
        expect(result.enabled).toBe(true);
    });

    test('template delete', () => {
        const result = runJson<{ deleted: boolean; id: number }>(`template delete --id ${templateId}`);
        expect(result.deleted).toBe(true);
    });
});
