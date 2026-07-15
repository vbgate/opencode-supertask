import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { setupTestDb } from './helpers/mock-db';
import { TaskService } from '../src/core/services/task.service';
import { TaskRunService } from '../src/core/services/task-run.service';
import { WorkerEngine } from '../src/worker';
import type { GatewayConfig } from '../src/gateway/config';
import type { TaskStatus } from '../src/core/db/schema';

const tempDirs: string[] = [];
const workers: WorkerEngine[] = [];

function createFakeOpencode(options: { exitCode?: number; delayMs?: number }) {
    const dir = mkdtempSync(join(tmpdir(), 'supertask-worker-test-'));
    tempDirs.push(dir);
    const executable = join(dir, 'fake-opencode');
    const argsFile = join(dir, 'args.json');
    const source = `#!/usr/bin/env bun
const args = Bun.argv.slice(2);
await Bun.write(${JSON.stringify(argsFile)}, JSON.stringify(args));
console.log(JSON.stringify({ sessionID: "ses_worker_test", message: "任务执行完成" }));
await Bun.sleep(${options.delayMs ?? 0});
process.exit(${options.exitCode ?? 0});
`;
    writeFileSync(executable, source);
    chmodSync(executable, 0o755);
    return { executable, argsFile, dir };
}

function createConfig(taskTimeoutMs = 2_000): GatewayConfig {
    return {
        configVersion: 2,
        worker: {
            maxConcurrency: 1,
            pollIntervalMs: 10,
            heartbeatIntervalMs: 20,
            taskTimeoutMs,
            shutdownGracePeriodMs: 500,
        },
        scheduler: {
            enabled: false,
            checkIntervalMs: 1_000,
        },
        watchdog: {
            heartbeatTimeoutMs: 1_000,
            checkIntervalMs: 60_000,
            cleanupIntervalMs: 60_000,
            retentionDays: 30,
        },
        dashboard: { enabled: false, port: 4680 },
    };
}

async function waitForStatus(taskId: number, statuses: TaskStatus[], timeoutMs = 3_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const task = await TaskService.getById(taskId);
        if (task?.status && statuses.includes(task.status as TaskStatus)) return task;
        await Bun.sleep(20);
    }
    throw new Error(`等待任务 #${taskId} 状态超时`);
}

describe('WorkerEngine', () => {
    beforeEach(() => {
        setupTestDb();
    });

    afterEach(async () => {
        await Promise.all(workers.splice(0).map((worker) => worker.stop()));
        for (const dir of tempDirs.splice(0)) {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('直接用参数数组执行目标 Agent 并记录成功结果', async () => {
        const fake = createFakeOpencode({});
        const marker = join(fake.dir, '不应被创建');
        const prompt = `完成测试；\"; touch ${marker}; #`;
        const task = await TaskService.add({
            name: '安全执行测试',
            agent: 'test-agent',
            model: 'test-model',
            prompt,
            maxRetries: 0,
        });
        const worker = new WorkerEngine(createConfig(), { opencodeBin: fake.executable });
        workers.push(worker);

        worker.start();
        const completed = await waitForStatus(task.id, ['done']);
        const args = JSON.parse(readFileSync(fake.argsFile, 'utf-8')) as string[];
        const runs = await TaskRunService.listByTaskId(task.id);

        expect(args).toEqual([
            'run', '--agent', 'test-agent', '--format', 'json',
            '-m', 'test-model', prompt,
        ]);
        expect(existsSync(marker)).toBe(false);
        expect(completed.resultLog).toContain('任务执行完成');
        expect(runs).toHaveLength(1);
        expect(runs[0].status).toBe('done');
        expect(runs[0].sessionId).toBe('ses_worker_test');
        expect(runs[0].log).toContain('任务执行完成');
    });

    test('非零退出码进入 dead_letter 并保留日志', async () => {
        const fake = createFakeOpencode({ exitCode: 7 });
        const task = await TaskService.add({
            name: '失败执行测试',
            agent: 'test-agent',
            prompt: '返回非零退出码',
            maxRetries: 0,
        });
        const worker = new WorkerEngine(createConfig(), { opencodeBin: fake.executable });
        workers.push(worker);

        worker.start();
        const failed = await waitForStatus(task.id, ['dead_letter']);
        const runs = await TaskRunService.listByTaskId(task.id);

        expect(failed.resultLog).toContain('退出码 7');
        expect(runs[0].status).toBe('failed');
        expect(runs[0].log).toContain('退出码 7');
    });

    test('超过任务超时后终止进程并进入 dead_letter', async () => {
        const fake = createFakeOpencode({ delayMs: 2_000 });
        const task = await TaskService.add({
            name: '超时执行测试',
            agent: 'test-agent',
            prompt: '运行时间超过限制',
            maxRetries: 0,
        });
        const worker = new WorkerEngine(createConfig(80), { opencodeBin: fake.executable });
        workers.push(worker);

        worker.start();
        const failed = await waitForStatus(task.id, ['dead_letter']);
        const runs = await TaskRunService.listByTaskId(task.id);

        expect(failed.resultLog).toContain('任务超时');
        expect(runs[0].status).toBe('failed');
        expect(runs[0].log).toContain('任务超时');
    });

    test('运行中任务被取消后终止子进程并关闭 run', async () => {
        const fake = createFakeOpencode({ delayMs: 10_000 });
        const task = await TaskService.add({
            name: '运行中取消测试',
            agent: 'test-agent',
            prompt: '等待取消',
            maxRetries: 0,
        });
        const worker = new WorkerEngine(createConfig(), { opencodeBin: fake.executable });
        workers.push(worker);

        worker.start();
        await waitForStatus(task.id, ['running']);
        await TaskService.cancel(task.id);

        const cancelled = await waitForStatus(task.id, ['cancelled']);
        const deadline = Date.now() + 3000;
        let runs = await TaskRunService.listByTaskId(task.id);
        while (runs[0]?.status === 'running' && Date.now() < deadline) {
            await Bun.sleep(20);
            runs = await TaskRunService.listByTaskId(task.id);
        }

        expect(cancelled.status).toBe('cancelled');
        expect(cancelled.finishedAt).not.toBeNull();
        expect(runs[0].status).toBe('failed');
        expect(runs[0].log).toContain('任务已取消');
        expect(worker.getRunningCount()).toBe(0);
    });

    test('优雅停止在宽限期内等待任务自然完成', async () => {
        const fake = createFakeOpencode({ delayMs: 120 });
        const task = await TaskService.add({
            name: '优雅停止测试',
            agent: 'test-agent',
            prompt: '短任务自然完成',
            maxRetries: 0,
        });
        const worker = new WorkerEngine(createConfig(), { opencodeBin: fake.executable });
        workers.push(worker);

        worker.start();
        await waitForStatus(task.id, ['running']);
        const interrupted = await worker.stop(1000);
        const completed = await waitForStatus(task.id, ['done']);

        expect(interrupted).toEqual([]);
        expect(completed.status).toBe('done');
        expect(worker.getRunningCount()).toBe(0);
    });

    test('优雅停止超过宽限期后返回被中断任务', async () => {
        const fake = createFakeOpencode({ delayMs: 10_000 });
        const task = await TaskService.add({
            name: '宽限期超时测试',
            agent: 'test-agent',
            prompt: '必须被中断',
            maxRetries: 0,
        });
        const worker = new WorkerEngine(createConfig(), { opencodeBin: fake.executable });
        workers.push(worker);

        worker.start();
        await waitForStatus(task.id, ['running']);
        const interrupted = await worker.stop(50);

        expect(interrupted).toEqual([task.id]);
        expect(worker.getRunningCount()).toBe(0);
    });
});
