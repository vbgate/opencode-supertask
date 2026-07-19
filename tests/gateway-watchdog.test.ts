import { describe, test, expect, beforeEach } from 'bun:test';
import { setupTestDb } from './helpers/mock-db';
import { checkHeartbeats } from '../src/gateway/watchdog/heartbeat';
import { cleanupOldRecords } from '../src/gateway/watchdog/cleanup';
import { Watchdog } from '../src/gateway/watchdog';
import { TaskService } from '../src/core/services/task.service';
import { TaskRunService } from '../src/core/services/task-run.service';
import { spawn } from 'child_process';
import type { GatewayConfig } from '../src/gateway/config';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
    LAUNCH_IDENTITY_ARGUMENT,
    TOKEN_GUARDIAN_LAUNCH_PROTOCOL,
} from '../src/core/launch-protocol';
import {
    isProcessAlive,
    signalSpawnedProcessTree,
    waitForSpawnedProcessTreeExit,
} from '../src/core/process-control';

async function createTask(overrides: Record<string, unknown> = {}) {
    return TaskService.add({
        name: '看门狗测试',
        agent: 'test-agent',
        prompt: '测试',
        ...overrides,
    });
}

function createWatchdogConfig(): GatewayConfig {
    return {
        configVersion: 2,
        worker: {
            maxConcurrency: 1,
            pollIntervalMs: 100,
            heartbeatIntervalMs: 1_000,
            taskTimeoutMs: 60_000,
            shutdownGracePeriodMs: 1_000,
        },
        scheduler: {
            enabled: false,
            checkIntervalMs: 60_000,
        },
        watchdog: {
            heartbeatTimeoutMs: -100_000,
            checkIntervalMs: 60_000,
            cleanupIntervalMs: 60_000,
            retentionDays: 30,
        },
        dashboard: { enabled: false, port: 4680 },
    };
}

describe('Watchdog lifecycle', () => {
    beforeEach(() => {
        setupTestDb();
    });

    test('stop 等待正在查询的心跳检查，避免停机期间抢占 Worker run', async () => {
        const task = await createTask({ maxRetries: 0 });
        await TaskService.start(task.id);
        const run = await TaskRunService.create({
            taskId: task.id,
            status: 'running',
            launchProtocol: 'gated-v2-guardian',
        });
        const originalGetStaleRuns = TaskRunService.getStaleRuns;
        let releaseQuery = () => {};
        let queryStarted: () => void;
        const queryStartedPromise = new Promise<void>((resolve) => {
            queryStarted = resolve;
        });
        const releaseQueryPromise = new Promise<void>((resolve) => {
            releaseQuery = resolve;
        });
        TaskRunService.getStaleRuns = async (...args) => {
            queryStarted();
            await releaseQueryPromise;
            return originalGetStaleRuns.apply(TaskRunService, args);
        };
        let workerOwnsRun = true;
        const watchdog = new Watchdog(
            createWatchdogConfig(),
            (taskId, runId) => workerOwnsRun && taskId === task.id && runId === run.id,
        );

        try {
            watchdog.start();
            await queryStartedPromise;
            let stopped = false;
            const stopping = watchdog.stop().then(() => {
                stopped = true;
            });
            await Bun.sleep(10);
            expect(stopped).toBe(false);

            releaseQuery();
            await stopping;
            workerOwnsRun = false;

            expect((await TaskService.getById(task.id))?.status).toBe('running');
            expect((await TaskService.getById(task.id))?.retryCount).toBe(0);
            expect((await TaskRunService.getById(run.id))?.status).toBe('running');
        } finally {
            releaseQuery();
            await watchdog.stop();
            TaskRunService.getStaleRuns = originalGetStaleRuns;
        }
    });

    test('stop 等待当前 stale run 收敛，但不继续处理后续积压', async () => {
        const runs: Array<{ taskId: number; runId: number }> = [];
        for (let index = 0; index < 3; index += 1) {
            const task = await createTask({ name: `lifecycle-stale-${index}`, maxRetries: 0 });
            await TaskService.start(task.id);
            const run = await TaskRunService.create({
                taskId: task.id,
                status: 'running',
                launchProtocol: 'gated-v2-guardian',
            });
            runs.push({ taskId: task.id, runId: run.id });
        }
        const originalRecoverRun = TaskService.recoverRun;
        let recoverStarted: () => void;
        let releaseRecovery = () => {};
        const recoverStartedPromise = new Promise<void>((resolve) => {
            recoverStarted = resolve;
        });
        const releaseRecoveryPromise = new Promise<void>((resolve) => {
            releaseRecovery = resolve;
        });
        let recoverCalls = 0;
        TaskService.recoverRun = async (...args) => {
            recoverCalls += 1;
            if (recoverCalls === 1) {
                recoverStarted();
                await releaseRecoveryPromise;
            }
            return originalRecoverRun.apply(TaskService, args);
        };
        const watchdog = new Watchdog(createWatchdogConfig());

        try {
            watchdog.start();
            await recoverStartedPromise;
            const stopping = watchdog.stop();
            releaseRecovery();
            await stopping;

            expect(recoverCalls).toBe(1);
            expect((await TaskService.getById(runs[0].taskId))?.status).toBe('dead_letter');
            expect((await TaskRunService.getById(runs[0].runId))?.status).toBe('failed');
            for (const run of runs.slice(1)) {
                expect((await TaskService.getById(run.taskId))?.status).toBe('running');
                expect((await TaskRunService.getById(run.runId))?.status).toBe('running');
            }
        } finally {
            releaseRecovery();
            await watchdog.stop();
            TaskService.recoverRun = originalRecoverRun;
        }
    });
});

describe('checkHeartbeats', () => {
    beforeEach(() => {
        setupTestDb();
    });

    test('无 stale run 时什么都不做', async () => {
        await checkHeartbeats(-100000);
    });

    test('检测 stale run 并标记为 dead_letter（达到最大重试）', async () => {
        const task = await createTask({ maxRetries: 0 });
        await TaskService.start(task.id);
        await TaskRunService.create({ taskId: task.id, status: 'running', launchProtocol: 'gated-v2-guardian' });

        await checkHeartbeats(-100000);

        const updatedTask = await TaskService.getById(task.id);
        expect(updatedTask!.status).toBe('dead_letter');
    });

    test('检测 stale run 并重新安排重试（未达最大重试）', async () => {
        const task = await createTask({ maxRetries: 3 });
        await TaskService.start(task.id);
        await TaskRunService.create({ taskId: task.id, status: 'running', launchProtocol: 'gated-v2-guardian' });

        await checkHeartbeats(-100000);

        const updatedTask = await TaskService.getById(task.id);
        expect(updatedTask!.status).toBe('pending');
        expect(updatedTask!.retryAfter).not.toBeNull();
        expect(updatedTask!.retryCount).toBe(1);
    });

    test('心跳超时使用任务自己的退避基础间隔', async () => {
        const task = await createTask({ maxRetries: 1, retryBackoffMs: 5000 });
        await TaskService.start(task.id);
        await TaskRunService.create({ taskId: task.id, status: 'running', launchProtocol: 'gated-v2-guardian' });
        const before = Date.now();

        await checkHeartbeats(-100000);

        const updatedTask = await TaskService.getById(task.id);
        expect(updatedTask!.retryAfter!).toBeGreaterThanOrEqual(before + 5000);
        expect(updatedTask!.retryAfter!).toBeLessThanOrEqual(Date.now() + 5000);
    });

    test('多次心跳超时后达到 dead_letter', async () => {
        const task = await createTask({ maxRetries: 1 });
        await TaskService.start(task.id);
        await TaskRunService.create({ taskId: task.id, status: 'running', launchProtocol: 'gated-v2-guardian' });

        await checkHeartbeats(-100000);

        let updatedTask = await TaskService.getById(task.id);
        expect(updatedTask!.status).toBe('pending');
        expect(updatedTask!.retryCount).toBe(1);

        await TaskService.start(task.id);
        await TaskRunService.create({ taskId: task.id, status: 'running', launchProtocol: 'gated-v2-guardian' });

        await checkHeartbeats(-100000);

        updatedTask = await TaskService.getById(task.id);
        expect(updatedTask!.status).toBe('dead_letter');
        expect(updatedTask!.retryCount).toBe(2);
    });

    test('stale run 的 run 记录标记为 failed', async () => {
        const task = await createTask({ maxRetries: 3 });
        await TaskService.start(task.id);
        const run = await TaskRunService.create({ taskId: task.id, status: 'running', launchProtocol: 'gated-v2-guardian' });

        await checkHeartbeats(-100000);

        const updatedRun = await TaskRunService.getById(run.id);
        expect(updatedRun!.status).toBe('failed');
        expect(updatedRun!.log).toContain('心跳超时');
    });

    test('当前 Worker 精确持有的 run 即使心跳暂时过期也不被 Watchdog 抢占', async () => {
        const task = await createTask({ maxRetries: 0 });
        await TaskService.start(task.id);
        const run = await TaskRunService.create({
            taskId: task.id,
            status: 'running',
            launchProtocol: 'gated-v2-guardian',
        });

        const result = await checkHeartbeats(
            -100000,
            (taskId, runId) => taskId === task.id && runId === run.id,
        );

        expect(result.recoveredRuns).toBe(0);
        expect(result.quarantinedRuns).toBe(0);
        expect((await TaskService.getById(task.id))?.status).toBe('running');
        expect((await TaskRunService.getById(run.id))?.status).toBe('running');
    });

    test('停机信号只让当前 stale run 收敛，并在下一个 run 边界停止', async () => {
        const runs: Array<{ taskId: number; runId: number }> = [];
        for (let index = 0; index < 3; index += 1) {
            const task = await createTask({ name: `stale-${index}`, maxRetries: 0 });
            await TaskService.start(task.id);
            const run = await TaskRunService.create({
                taskId: task.id,
                status: 'running',
                launchProtocol: 'gated-v2-guardian',
            });
            runs.push({ taskId: task.id, runId: run.id });
        }
        let stopChecks = 0;

        const result = await checkHeartbeats(
            -100_000,
            () => false,
            () => {
                stopChecks += 1;
                return stopChecks > 1;
            },
        );

        expect(result.staleRuns).toBe(3);
        expect(result.recoveredRuns).toBe(1);
        expect((await TaskService.getById(runs[0].taskId))?.status).toBe('dead_letter');
        expect((await TaskRunService.getById(runs[0].runId))?.status).toBe('failed');
        for (const run of runs.slice(1)) {
            expect((await TaskService.getById(run.taskId))?.status).toBe('running');
            expect((await TaskRunService.getById(run.runId))?.status).toBe('running');
        }
    });

    test('stale run 边界让出事件循环，使停机信号不会被同步探测积压饿死', async () => {
        const task = await createTask({ maxRetries: 0 });
        await TaskService.start(task.id);
        const run = await TaskRunService.create({
            taskId: task.id,
            status: 'running',
            launchProtocol: 'gated-v2-guardian',
        });
        let stopped = false;
        setTimeout(() => {
            stopped = true;
        }, 0);

        const result = await checkHeartbeats(-100_000, () => false, () => stopped);

        expect(result.recoveredRuns).toBe(0);
        expect((await TaskService.getById(task.id))?.status).toBe('running');
        expect((await TaskRunService.getById(run.id))?.status).toBe('running');
    });

    test('旧版无 child pid 的 stale run 保持隔离，避免重复启动真实任务', async () => {
        const task = await createTask({ maxRetries: 3 });
        await TaskService.start(task.id);
        const run = await TaskRunService.create({ taskId: task.id, status: 'running' });

        const result = await checkHeartbeats(-100000);

        expect(result.quarantinedRuns).toBe(1);
        expect(result.recoveredRuns).toBe(0);
        expect((await TaskService.getById(task.id))?.status).toBe('running');
        expect((await TaskRunService.getById(run.id))?.status).toBe('running');
    });

    test('未知的非空 launch protocol 保持隔离且不能降级成 legacy abandon', async () => {
        const task = await createTask({ maxRetries: 3 });
        await TaskService.start(task.id);
        const run = await TaskRunService.create({
            taskId: task.id,
            status: 'running',
            launchProtocol: 'gated-v3-future',
            childPid: 2_147_483_647,
        });

        const result = await checkHeartbeats(-100000);

        expect(result.quarantinedRuns).toBe(1);
        expect(result.recoveredRuns).toBe(0);
        expect((await TaskRunService.getById(run.id))?.status).toBe('running');
        await TaskService.cancel(task.id);
        await expect(TaskRunService.abandonLegacyRun(run.id)).rejects.toThrow('未知或受管协议');
    });

    test('子进程身份不匹配时保持隔离，不重派也不误杀', async () => {
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
            stdio: 'ignore',
        });
        if (!child.pid) throw new Error('无法启动隔离测试子进程');

        try {
            const task = await createTask({ maxRetries: 3 });
            await TaskService.start(task.id);
            const run = await TaskRunService.create({ taskId: task.id, status: 'running', launchProtocol: 'gated-v2-guardian' });
            await TaskRunService.updatePid(run.id, 999_999_999, child.pid);

            const result = await checkHeartbeats(600_000);

            const updatedTask = await TaskService.getById(task.id);
            const updatedRun = await TaskRunService.getById(run.id);
            expect(updatedTask!.status).toBe('running');
            expect(updatedTask!.retryCount).toBe(0);
            expect(updatedRun!.status).toBe('running');
            expect(child.exitCode).toBeNull();
            expect(result.quarantinedRuns).toBe(1);
            expect(result.recoveredRuns).toBe(0);
        } finally {
            child.kill('SIGKILL');
            await new Promise<void>((resolve) => child.once('close', () => resolve()));
        }
    });

    test('旧 guardian 协议的进程组明确不存在时允许安全恢复', async () => {
        const task = await createTask({ maxRetries: 0 });
        await TaskService.start(task.id);
        const run = await TaskRunService.create({
            taskId: task.id,
            status: 'running',
            launchProtocol: 'gated-v2-guardian',
            childPid: 2_147_483_647,
            workerPid: 2_147_483_647,
        });

        const result = await checkHeartbeats(600_000);

        expect(result.quarantinedRuns).toBe(0);
        expect(result.recoveredRuns).toBe(1);
        expect((await TaskService.getById(task.id))?.status).toBe('dead_letter');
        expect((await TaskRunService.getById(run.id))?.status).toBe('failed');
    });

    test('旧 stale run 的 PID 被新合法 launcher 复用时按每 run 身份隔离', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'supertask-watchdog-pid-reuse-'));
        const executable = join(dir, 'fake-opencode');
        const readyFile = join(dir, 'ready');
        const launcher = join(process.cwd(), 'src/worker/launcher.ts');
        const staleIdentity = 'gateway-99:launch:11111111-1111-4111-8111-111111111111';
        const newIdentity = 'gateway-100:launch:22222222-2222-4222-8222-222222222222';
        writeFileSync(executable, `#!/usr/bin/env bun
import { writeFileSync } from 'fs';
writeFileSync(${JSON.stringify(readyFile)}, 'ready');
setInterval(() => {}, 1000);
`);
        chmodSync(executable, 0o755);
        const reused = spawn(process.execPath, [
            launcher,
            LAUNCH_IDENTITY_ARGUMENT,
            newIdentity,
            executable,
            'run', '--agent', 'test-agent', '--format', 'json', 'new legitimate run',
        ], { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
        if (!reused.pid) throw new Error('无法启动 PID 复用回归进程');

        try {
            await new Promise<void>((resolve, reject) => {
                reused.once('spawn', resolve);
                reused.once('error', reject);
            });
            reused.stdin!.end('START\n');
            const readyDeadline = Date.now() + 3_000;
            while (!existsSync(readyFile) && Date.now() < readyDeadline) await Bun.sleep(20);
            expect(existsSync(readyFile)).toBe(true);

            // 模拟旧 Gateway 在 launcher 已退出、run 尚未关闭时崩溃；旧 PID 随后被
            // 另一条合法 SuperTask launcher 复用，但数据库仍保存旧 run 的身份令牌。
            const task = await createTask({ maxRetries: 3 });
            await TaskService.start(task.id);
            const run = await TaskRunService.create({
                taskId: task.id,
                status: 'running',
                launchProtocol: TOKEN_GUARDIAN_LAUNCH_PROTOCOL,
                lockedBy: staleIdentity,
            });
            await TaskRunService.updatePid(run.id, 2_147_483_647, reused.pid, staleIdentity);

            const result = await checkHeartbeats(600_000);

            expect(result.quarantinedRuns).toBe(1);
            expect(result.recoveredRuns).toBe(0);
            expect(isProcessAlive(reused.pid)).toBe(true);
            expect((await TaskService.getById(task.id))?.status).toBe('running');
            expect((await TaskRunService.getById(run.id))?.status).toBe('running');
        } finally {
            signalSpawnedProcessTree(reused.pid, 'SIGKILL');
            await waitForSpawnedProcessTreeExit(reused.pid, 3_000);
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('cleanupOldRecords', () => {
    let sqlite: ReturnType<typeof setupTestDb>['sqlite'];

    beforeEach(() => {
        ({ sqlite } = setupTestDb());
    });

    test('清理已完成的旧任务', async () => {
        const task = await createTask();
        await TaskService.start(task.id);
        await TaskService.done(task.id, '完成');

        const deleted = await cleanupOldRecords(-1);
        expect(deleted).toBe(1);

        const found = await TaskService.getById(task.id);
        expect(found).toBeNull();
    });

    test('保留仍可自动重试的 failed，清理 dead_letter 和 cancelled', async () => {
        const t1 = await createTask({ name: 'T1', maxRetries: 1 });
        await TaskService.start(t1.id);
        await TaskService.fail(t1.id, '失败');

        const t2 = await createTask({ name: 'T2', maxRetries: 1 });
        await TaskService.start(t2.id);
        await TaskService.fail(t2.id, '死信', {}, { setDeadLetter: true });

        const t3 = await createTask({ name: 'T3' });
        await TaskService.cancel(t3.id);

        const deleted = await cleanupOldRecords(-1);
        expect(deleted).toBe(2);
        expect(await TaskService.getById(t1.id)).not.toBeNull();
        expect(await TaskService.getById(t2.id)).toBeNull();
        expect(await TaskService.getById(t3.id)).toBeNull();
    });

    test('不清理 pending/running 任务', async () => {
        const t1 = await createTask({ name: 'P' });
        const t2 = await createTask({ name: 'R' });
        await TaskService.start(t2.id);

        await cleanupOldRecords(-1);

        const found1 = await TaskService.getById(t1.id);
        const found2 = await TaskService.getById(t2.id);
        expect(found1).not.toBeNull();
        expect(found2).not.toBeNull();
    });

    test('同时清理关联的 run 记录', async () => {
        const task = await createTask();
        await TaskService.start(task.id);
        const run = await TaskRunService.create({ taskId: task.id, status: 'running' });
        await TaskRunService.done(run.id);
        await TaskService.done(task.id);

        await cleanupOldRecords(-1);

        const runs = await TaskRunService.listByTaskId(task.id);
        expect(runs.length).toBe(0);
    });

    test('受依赖保护的旧任务及其 run 必须一起保留', async () => {
        const prerequisite = await TaskService.add({
            name: '仍被依赖的前置任务',
            agent: 'test-agent',
            prompt: '完成前置步骤',
        });
        await TaskService.start(prerequisite.id);
        const run = await TaskRunService.create({ taskId: prerequisite.id, status: 'running' });
        await TaskService.completeRun(prerequisite.id, run.id, '完成');
        await TaskService.add({
            name: '待执行的下游任务',
            agent: 'test-agent',
            prompt: '依赖前置步骤',
            dependsOn: prerequisite.id,
        });

        expect(await cleanupOldRecords(-1)).toBe(0);
        expect(await TaskService.getById(prerequisite.id)).not.toBeNull();
        expect(await TaskRunService.getById(run.id)).not.toBeNull();
    });

    test('已取消但进程尚未退出的任务不能被过期清理', async () => {
        const task = await TaskService.add({
            name: '取消后仍在退出中的任务',
            agent: 'test-agent',
            prompt: '保持 run 直到进程确认退出',
        });
        await TaskService.start(task.id);
        const run = await TaskRunService.create({ taskId: task.id, status: 'running' });
        await TaskService.cancel(task.id);

        expect(await cleanupOldRecords(-1)).toBe(0);
        expect(await TaskService.getById(task.id)).not.toBeNull();
        expect((await TaskRunService.getById(run.id))?.status).toBe('running');
    });

    test('超过单批上限的历史数据会分批清理到零', async () => {
        const insert = sqlite.prepare(`
            INSERT INTO tasks (name, agent, prompt, status, finished_at, result_log)
            VALUES (?, 'test-agent', 'cleanup', 'done', ?, ?)
        `);
        sqlite.transaction(() => {
            for (let index = 0; index < 1_205; index += 1) {
                insert.run(`历史任务 ${index}`, 1, 'x'.repeat(1024));
            }
        })();

        expect(await cleanupOldRecords(-1)).toBe(1_205);
        const remaining = sqlite.query('SELECT count(*) AS count FROM tasks').get() as { count: number };
        expect(remaining.count).toBe(0);
    });

    test('停机信号在清理批次边界生效，最多再等待一个批次', async () => {
        const insert = sqlite.prepare(`
            INSERT INTO tasks (name, agent, prompt, status, finished_at, result_log)
            VALUES (?, 'test-agent', 'cleanup', 'done', ?, ?)
        `);
        sqlite.transaction(() => {
            for (let index = 0; index < 1_205; index += 1) {
                insert.run(`待中断清理任务 ${index}`, 1, 'x'.repeat(1024));
            }
        })();
        let stopChecks = 0;

        const deleted = await cleanupOldRecords(-1, () => {
            stopChecks += 1;
            return stopChecks > 1;
        });

        expect(deleted).toBe(500);
        const remaining = sqlite.query('SELECT count(*) AS count FROM tasks').get() as { count: number };
        expect(remaining.count).toBe(705);
    });

    test('依赖链在首批后停机也不会留下悬空 depends_on', async () => {
        let dependsOn: number | null = null;
        const insert = sqlite.prepare(`
            INSERT INTO tasks (
                name, agent, prompt, status, depends_on, finished_at, retry_count, max_retries
            ) VALUES (?, 'test-agent', 'cleanup', 'dead_letter', ?, 1, 1, 0)
            RETURNING id
        `);
        for (let index = 0; index < 501; index += 1) {
            const row = insert.get(`停机依赖链 ${index}`, dependsOn) as { id: number };
            dependsOn = row.id;
        }
        let stopChecks = 0;

        expect(await cleanupOldRecords(-1, () => ++stopChecks > 1)).toBe(500);
        const dangling = sqlite.query(`
            SELECT dependent.id
            FROM tasks AS dependent
            WHERE dependent.depends_on IS NOT NULL
              AND dependent.status IN ('pending', 'running', 'failed', 'dead_letter')
              AND NOT EXISTS (
                  SELECT 1 FROM tasks AS prerequisite
                  WHERE prerequisite.id = dependent.depends_on
              )
        `).all();
        expect(dangling).toEqual([]);
        expect((sqlite.query('SELECT count(*) AS count FROM tasks').get() as { count: number }).count).toBe(1);
    });

    test('跨批清理与人工重试竞态不会产生依赖已删除的永久 pending', async () => {
        let dependsOn: number | null = null;
        const insert = sqlite.prepare(`
            INSERT INTO tasks (
                name, agent, prompt, status, depends_on, finished_at, retry_count, max_retries
            ) VALUES (?, 'test-agent', 'cleanup', 'dead_letter', ?, 1, 1, 0)
            RETURNING id
        `);
        for (let index = 0; index < 501; index += 1) {
            const row = insert.get(`竞态依赖链 ${index}`, dependsOn) as { id: number };
            dependsOn = row.id;
        }
        const lastTaskId = dependsOn!;
        let boundaryChecks = 0;
        let retryPromise: Promise<Awaited<ReturnType<typeof TaskService.retry>>> | null = null;

        const deleted = await cleanupOldRecords(-1, () => {
            boundaryChecks += 1;
            if (boundaryChecks === 2) retryPromise = TaskService.retry(lastTaskId);
            return false;
        });

        expect(await retryPromise).toBeNull();
        expect(deleted).toBe(501);
        expect((sqlite.query('SELECT count(*) AS count FROM tasks').get() as { count: number }).count).toBe(0);
    });

    test('一次清理会收敛整条过期 dead_letter 依赖链', async () => {
        let dependsOn: number | null = null;
        const insert = sqlite.prepare(`
            INSERT INTO tasks (
                name, agent, prompt, status, depends_on, finished_at, retry_count, max_retries
            ) VALUES (?, 'test-agent', 'cleanup', 'dead_letter', ?, 1, 1, 0)
            RETURNING id
        `);
        for (let index = 0; index < 750; index += 1) {
            const row = insert.get(`依赖链 ${index}`, dependsOn) as { id: number };
            dependsOn = row.id;
        }

        expect(await cleanupOldRecords(-1)).toBe(750);
        const remaining = sqlite.query('SELECT count(*) AS count FROM tasks').get() as { count: number };
        expect(remaining.count).toBe(0);
    });

    test('只清理过期且无活跃实例的 disabled delayed 模板', async () => {
        const old = Date.now() - 31 * 86_400_000;
        const insertTemplate = sqlite.prepare(`
            INSERT INTO task_templates (
                name, agent, prompt, schedule_type, enabled, last_run_at, run_at
            ) VALUES (?, 'a', 'p', ?, ?, ?, 1)
            RETURNING id
        `);
        const removable = (insertTemplate.get('可清理 delayed', 'delayed', 0, old) as { id: number }).id;
        const recent = (insertTemplate.get('近期 delayed', 'delayed', 0, Date.now()) as { id: number }).id;
        const cron = (insertTemplate.get('cron', 'cron', 0, old) as { id: number }).id;
        const recurring = (insertTemplate.get('recurring', 'recurring', 0, old) as { id: number }).id;
        const enabled = (insertTemplate.get('仍启用 delayed', 'delayed', 1, old) as { id: number }).id;
        const pending = (insertTemplate.get('pending 实例', 'delayed', 0, old) as { id: number }).id;
        const retryable = (insertTemplate.get('可重试实例', 'delayed', 0, old) as { id: number }).id;
        const runningRun = (insertTemplate.get('running run', 'delayed', 0, old) as { id: number }).id;

        sqlite.query(`
            INSERT INTO tasks (name, agent, prompt, template_id, status, finished_at)
            VALUES ('已完成实例', 'a', 'p', ?, 'done', 1)
        `).run(removable);
        sqlite.query(`
            INSERT INTO tasks (name, agent, prompt, template_id, status)
            VALUES ('待执行实例', 'a', 'p', ?, 'pending')
        `).run(pending);
        sqlite.query(`
            INSERT INTO tasks (
                name, agent, prompt, template_id, status, retry_count, max_retries
            ) VALUES ('等待重试实例', 'a', 'p', ?, 'failed', 1, 3)
        `).run(retryable);
        const runningTask = sqlite.query(`
            INSERT INTO tasks (name, agent, prompt, template_id, status, finished_at)
            VALUES ('run 未关闭实例', 'a', 'p', ?, 'done', 1)
            RETURNING id
        `).get(runningRun) as { id: number };
        sqlite.query(`
            INSERT INTO task_runs (task_id, status) VALUES (?, 'running')
        `).run(runningTask.id);

        expect(await cleanupOldRecords(30)).toBe(1);
        const remaining = sqlite.query(`
            SELECT id FROM task_templates ORDER BY id
        `).all() as Array<{ id: number }>;
        const remainingIds = remaining.map((template) => template.id);
        expect(remainingIds).not.toContain(removable);
        expect(remainingIds).toEqual([
            recent, cron, recurring, enabled, pending, retryable, runningRun,
        ]);
    });

    test('历史清理后续页使用 rowid 上界且无需临时排序', () => {
        const plan = sqlite.query(`
            EXPLAIN QUERY PLAN
            SELECT candidate.id
            FROM tasks AS candidate NOT INDEXED
            WHERE candidate.status IN ('done', 'dead_letter', 'cancelled')
              AND candidate.finished_at IS NOT NULL
              AND candidate.finished_at < ?
              AND candidate.id < ?
              AND NOT EXISTS (
                  SELECT 1 FROM task_runs AS active_run
                  WHERE active_run.task_id = candidate.id
                    AND active_run.status = 'running'
              )
            ORDER BY candidate.id DESC
            LIMIT ?
        `).all(Math.floor(Date.now() / 1000), 10_000, 500) as Array<{ detail: string }>;

        expect(plan.some((row) => (
            row.detail.includes('INTEGER PRIMARY KEY') && row.detail.includes('rowid<?')
        ))).toBe(true);
        expect(plan.some((row) => row.detail.includes('USE TEMP B-TREE'))).toBe(false);
    });

    test('delayed 模板 retention 查询命中复合索引且无需临时排序', () => {
        const plan = sqlite.query(`
            EXPLAIN QUERY PLAN
            SELECT id FROM task_templates
            WHERE schedule_type = 'delayed'
              AND enabled = 0
              AND last_run_at IS NOT NULL
              AND last_run_at < ?
            ORDER BY last_run_at, id
            LIMIT 500
        `).all(Date.now()) as Array<{ detail: string }>;

        expect(plan.some((row) => row.detail.includes('task_templates_retention_idx'))).toBe(true);
        expect(plan.some((row) => row.detail.includes('USE TEMP B-TREE'))).toBe(false);
    });
});
