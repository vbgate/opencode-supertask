import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
    chmodSync,
    existsSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawn } from 'child_process';
import { setupTestDb } from './helpers/mock-db';
import { TaskService } from '../src/core/services/task.service';
import { TaskRunService } from '../src/core/services/task-run.service';
import { WorkerEngine, assertWorkerProcessIsolationSupported } from '../src/worker';
import { waitForProcessGroupDrain } from '../src/worker/launcher';
import type { GatewayConfig } from '../src/gateway/config';
import type { TaskStatus } from '../src/core/db/schema';
import {
    isProcessAlive,
    signalSpawnedProcessTree,
    waitForSpawnedProcessTreeExit,
} from '../src/core/process-control';
import {
    drainProofAckForIdentity,
    isMatchingDrainProof,
    LAUNCH_IDENTITY_ARGUMENT,
    MANAGED_RUN_ENV,
    MANAGED_RUN_ENV_VALUE,
    TOKEN_GUARDIAN_LAUNCH_PROTOCOL,
} from '../src/core/launch-protocol';

const tempDirs: string[] = [];
const workers: WorkerEngine[] = [];
let testDb: ReturnType<typeof setupTestDb>;

function createFakeOpencode(options: {
    exitCode?: number;
    delayMs?: number;
    ignoreSigterm?: boolean;
}) {
    const dir = mkdtempSync(join(tmpdir(), 'supertask-worker-test-'));
    tempDirs.push(dir);
    const executable = join(dir, 'fake-opencode');
    const argsFile = join(dir, 'args.json');
    const envFile = join(dir, 'env.json');
    const source = `#!/usr/bin/env bun
const args = Bun.argv.slice(2);
await Bun.write(${JSON.stringify(argsFile)}, JSON.stringify(args));
await Bun.write(${JSON.stringify(envFile)}, JSON.stringify({
    managedRun: process.env[${JSON.stringify(MANAGED_RUN_ENV)}],
    pwd: process.env.PWD,
    cwd: process.cwd(),
}));
console.log(JSON.stringify({ sessionID: "ses_worker_test", message: "任务执行完成" }));
${options.ignoreSigterm ? "process.on('SIGTERM', () => {});" : ''}
await Bun.sleep(${options.delayMs ?? 0});
process.exit(${options.exitCode ?? 0});
`;
    writeFileSync(executable, source);
    chmodSync(executable, 0o755);
    return { executable, argsFile, envFile, dir };
}

function createOrphaningFakeOpencode() {
    const dir = mkdtempSync(join(tmpdir(), 'supertask-worker-orphan-test-'));
    tempDirs.push(dir);
    const executable = join(dir, 'fake-opencode');
    const argsFile = join(dir, 'args.json');
    const childPidFile = join(dir, 'child.pid');
    const childReadyFile = join(dir, 'child.ready');
    const firstRunMarker = join(dir, 'first-run');
    const source = `#!/usr/bin/env bun
import { existsSync, writeFileSync } from 'fs';
import { spawn } from 'child_process';
const args = Bun.argv.slice(2);
await Bun.write(${JSON.stringify(argsFile)}, JSON.stringify(args));
console.log(JSON.stringify({ sessionID: "ses_worker_orphan_test", message: "launcher 即将退出" }));
if (!existsSync(${JSON.stringify(firstRunMarker)})) {
    writeFileSync(${JSON.stringify(firstRunMarker)}, '1');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(`process.on('SIGTERM', () => {}); await Bun.write(${JSON.stringify(childReadyFile)}, 'ready'); setInterval(() => {}, 1000);`)}], {
        stdio: 'ignore',
    });
    writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));
    child.unref();
    const deadline = Date.now() + 3000;
    while (!existsSync(${JSON.stringify(childReadyFile)}) && Date.now() < deadline) await Bun.sleep(10);
}
`;
    writeFileSync(executable, source);
    chmodSync(executable, 0o755);
    return { executable, argsFile, childPidFile, dir };
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

async function waitForStatus(taskId: number, statuses: TaskStatus[], timeoutMs = 8_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const task = await TaskService.getById(taskId);
        if (task?.status && statuses.includes(task.status as TaskStatus)) return task;
        await Bun.sleep(20);
    }
    throw new Error(`等待任务 #${taskId} 状态超时`);
}

async function waitForWorkerCount(worker: WorkerEngine, count: number, timeoutMs = 3_000) {
    const deadline = Date.now() + timeoutMs;
    while (worker.getRunningCount() !== count && Date.now() < deadline) {
        await Bun.sleep(20);
    }
    expect(worker.getRunningCount()).toBe(count);
}

describe('WorkerEngine', () => {
    test('Windows 在没有 Job Object 隔离时拒绝启动 Worker', () => {
        expect(() => assertWorkerProcessIsolationSupported('win32')).toThrow('Job Object');
        expect(() => assertWorkerProcessIsolationSupported('darwin')).not.toThrow();
        expect(() => assertWorkerProcessIsolationSupported('linux')).not.toThrow();
    });

    test('guardian 进程组探测使用 1s 到 5s 的有界退避', async () => {
        const delays: number[] = [];
        let probes = 0;

        await waitForProcessGroupDrain({
            probe: async () => {
                probes += 1;
                return probes <= 5;
            },
            delay: async (milliseconds) => {
                delays.push(milliseconds);
            },
        });

        expect(probes).toBe(6);
        expect(delays).toEqual([1_000, 2_000, 4_000, 5_000, 5_000]);
    });

    beforeEach(() => {
        testDb = setupTestDb();
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
            variant: 'xhigh',
            prompt,
            maxRetries: 0,
            cwd: fake.dir,
        });
        const worker = new WorkerEngine(createConfig(), { opencodeBin: fake.executable });
        workers.push(worker);

        worker.start();
        const completed = await waitForStatus(task.id, ['done']);
        const args = JSON.parse(readFileSync(fake.argsFile, 'utf-8')) as string[];
        const childEnv = JSON.parse(readFileSync(fake.envFile, 'utf-8')) as {
            managedRun?: string;
            pwd?: string;
            cwd: string;
        };
        const runs = await TaskRunService.listByTaskId(task.id);

        expect(args).toEqual([
            'run', '--agent', 'test-agent', '--format', 'json',
            '-m', 'test-model', '--variant', 'xhigh', prompt,
        ]);
        expect(childEnv.managedRun).toBe(MANAGED_RUN_ENV_VALUE);
        if (!childEnv.pwd) throw new Error('子进程未记录 PWD');
        const expectedCwd = realpathSync(fake.dir);
        expect(realpathSync(childEnv.cwd)).toBe(expectedCwd);
        expect(realpathSync(childEnv.pwd)).toBe(expectedCwd);
        expect(existsSync(marker)).toBe(false);
        expect(completed.resultLog).toContain('任务执行完成');
        expect(runs).toHaveLength(1);
        expect(runs[0].status).toBe('done');
        expect(runs[0].variant).toBe('xhigh');
        expect(runs[0].workerPid).toBe(process.pid);
        expect(runs[0].launchProtocol).toBe(TOKEN_GUARDIAN_LAUNCH_PROTOCOL);
        expect(runs[0].lockedBy).toMatch(/^gateway-\d+:launch:/);
        expect(runs[0].sessionId).toBe('ses_worker_test');
        expect(runs[0].log).toContain('任务执行完成');
        expect(runs[0].log).toContain('"type":"supertask_command"');
        expect(runs[0].log).toContain('"args":["run","--agent","test-agent"');
        expect(runs[0].log).toContain('"--variant","xhigh"');
        expect(runs[0].log).toContain(JSON.stringify(prompt).slice(1, -1));
    });

    test('停机发生在 claim 期间时把无 run 的任务恢复为 pending', async () => {
        const task = await TaskService.add({
            name: 'claim 停机竞态', agent: 'test-agent', prompt: '不得启动',
        });
        const originalClaimNext = TaskService.claimNext;
        let releaseClaim = () => {};
        let markClaimStarted = () => {};
        const claimStarted = new Promise<void>((resolve) => {
            markClaimStarted = resolve;
        });
        const claimGate = new Promise<void>((resolve) => {
            releaseClaim = resolve;
        });
        TaskService.claimNext = async (...args) => {
            markClaimStarted();
            await claimGate;
            return originalClaimNext.apply(TaskService, args);
        };
        const worker = new WorkerEngine(createConfig(), { opencodeBin: '/definitely/not/opencode' });
        workers.push(worker);

        try {
            worker.start();
            await claimStarted;
            const stopping = worker.stop();
            releaseClaim();
            expect(await stopping).toEqual([]);
            expect(await TaskService.getById(task.id)).toMatchObject({ status: 'pending' });
            expect(await TaskRunService.listByTaskId(task.id)).toEqual([]);
        } finally {
            TaskService.claimNext = originalClaimNext;
        }
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
        expect(failed.resultLog).toContain('agent=test-agent');
        expect(failed.resultLog).toContain('model=Agent/默认配置');
        expect(failed.resultLog).toContain('variant=Agent/模型默认配置');
        expect(failed.resultLog).not.toContain('guardian 未提供受管进程组排空证明');
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

    test('首次无法确认终止时会复核隔离态，并在受管进程组排空后释放 Worker', async () => {
        const fake = createFakeOpencode({ delayMs: 140 });
        const task = await TaskService.add({
            name: '隔离态收敛测试',
            agent: 'test-agent',
            prompt: '首次终止失败后自然退出',
            maxRetries: 0,
        });
        const config = createConfig(80);
        config.worker.pollIntervalMs = 200;
        const worker = new WorkerEngine(config, { opencodeBin: fake.executable });
        workers.push(worker);
        const internals = worker as unknown as {
            killEntry(entry: object, signal?: NodeJS.Signals): Promise<boolean>;
        };
        const originalKillEntry = internals.killEntry.bind(worker);
        let killAttempts = 0;
        internals.killEntry = async (entry, signal) => {
            killAttempts += 1;
            if (killAttempts === 1) return false;
            return originalKillEntry(entry, signal);
        };

        worker.start();
        await waitForStatus(task.id, ['running']);
        const run = await TaskRunService.getRunningRunByTaskId(task.id);
        expect(run).not.toBeNull();
        expect(worker.ownsRun(task.id, run!.id)).toBe(true);
        expect(worker.ownsRun(task.id, run!.id + 1)).toBe(false);

        const failed = await waitForStatus(task.id, ['dead_letter'], 3_000);
        await waitForWorkerCount(worker, 0);

        expect(killAttempts).toBeGreaterThanOrEqual(2);
        expect(failed.resultLog).toContain('任务超时');
        expect(worker.ownsRun(task.id, run!.id)).toBe(false);
    });

    test('旧 launcher PID 被新合法 launcher 复用时本地终止保持隔离且不误杀', async () => {
        const fake = createFakeOpencode({ delayMs: 10_000 });
        const launcher = join(process.cwd(), 'src/worker/launcher.ts');
        const staleIdentity = 'gateway-99:launch:11111111-1111-4111-8111-111111111111';
        const newIdentity = 'gateway-100:launch:22222222-2222-4222-8222-222222222222';
        const reused = spawn(process.execPath, [
            launcher,
            LAUNCH_IDENTITY_ARGUMENT,
            newIdentity,
            fake.executable,
            'run', '--agent', 'test-agent', '--format', 'json', 'new legitimate run',
        ], { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
        if (!reused.pid || !reused.stdin) throw new Error('无法启动 Worker PID 复用回归进程');

        try {
            reused.stdin.end('START\n');
            const readyDeadline = Date.now() + 3_000;
            while (!existsSync(fake.argsFile) && Date.now() < readyDeadline) await Bun.sleep(20);
            expect(existsSync(fake.argsFile)).toBe(true);

            const task = await TaskService.add({
                name: '旧 Worker 等待结算',
                agent: 'test-agent',
                prompt: '旧 launcher 已退出，PID 被新 launcher 复用',
                maxRetries: 0,
            });
            await TaskService.start(task.id);
            const run = await TaskRunService.create({
                taskId: task.id,
                status: 'running',
                launchProtocol: TOKEN_GUARDIAN_LAUNCH_PROTOCOL,
                lockedBy: staleIdentity,
            });
            await TaskRunService.updatePid(run.id, process.pid, reused.pid, staleIdentity);
            const worker = new WorkerEngine(createConfig(), { opencodeBin: fake.executable });
            const entry = {
                task,
                runId: run.id,
                launchIdentity: staleIdentity,
                child: reused,
                output: '',
                sessionId: null,
                timeoutTimer: null,
                termination: null,
                terminationPromise: null,
                settlementPromise: null,
                quarantined: false,
                settled: false,
            };
            const internals = worker as unknown as {
                terminateForFailure(
                    running: typeof entry,
                    message: string,
                    signal: NodeJS.Signals,
                ): Promise<boolean>;
            };

            expect(await internals.terminateForFailure(entry, '旧任务超时', 'SIGKILL')).toBe(false);
            expect(entry.quarantined).toBe(true);
            expect(isProcessAlive(reused.pid)).toBe(true);
            expect((await TaskService.getById(task.id))?.status).toBe('running');
            expect((await TaskRunService.getById(run.id))?.status).toBe('running');
        } finally {
            signalSpawnedProcessTree(reused.pid, 'SIGKILL');
            await waitForSpawnedProcessTreeExit(reused.pid, 3_000);
        }
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

    test('取消与子进程失败竞态仍会立即关闭 run', async () => {
        const fake = createFakeOpencode({ exitCode: 7, delayMs: 100 });
        const task = await TaskService.add({
            name: '取消失败竞态测试',
            agent: 'test-agent',
            prompt: '取消后立即失败',
            maxRetries: 0,
        });
        const config = createConfig();
        config.worker.pollIntervalMs = 10_000;
        const worker = new WorkerEngine(config, { opencodeBin: fake.executable });
        workers.push(worker);

        worker.start();
        await waitForStatus(task.id, ['running']);
        await TaskService.cancel(task.id);
        const deadline = Date.now() + 3_000;
        let runs = await TaskRunService.listByTaskId(task.id);
        while (runs[0]?.status === 'running' && Date.now() < deadline) {
            await Bun.sleep(20);
            runs = await TaskRunService.listByTaskId(task.id);
        }
        expect((await TaskService.getById(task.id))!.status).toBe('cancelled');
        expect(runs[0].status).toBe('failed');
        expect(runs[0].log).toContain('任务状态已被其他操作改变');
        expect(worker.getRunningCount()).toBe(0);
    });

    test('OpenCode 主进程退出但后代仍存活时 guardian 保持组长并阻止提前结算', async () => {
        const fake = createOrphaningFakeOpencode();
        const first = await TaskService.add({
            name: '残留进程组任务',
            agent: 'test-agent',
            prompt: '派生后代后退出',
            batchId: 'residual-tree-batch',
            maxRetries: 0,
        });
        const second = await TaskService.add({
            name: '同批次后续任务',
            agent: 'test-agent',
            prompt: '必须等待受管进程组排空',
            batchId: 'residual-tree-batch',
            maxRetries: 0,
        });
        const config = createConfig();
        config.worker.maxConcurrency = 2;
        const worker = new WorkerEngine(config, { opencodeBin: fake.executable });
        workers.push(worker);

        worker.start();
        await waitForStatus(first.id, ['running']);
        const pidDeadline = Date.now() + 3_000;
        while (!existsSync(fake.childPidFile) && Date.now() < pidDeadline) await Bun.sleep(20);
        expect(existsSync(fake.childPidFile)).toBe(true);
        const descendantPid = Number(readFileSync(fake.childPidFile, 'utf8'));

        await Bun.sleep(150);
        const activeRun = await TaskRunService.getRunningRunByTaskId(first.id);
        expect(activeRun?.childPid).not.toBeNull();
        expect(isProcessAlive(descendantPid)).toBe(true);
        expect(isProcessAlive(activeRun!.childPid!)).toBe(true);
        expect((await TaskService.getById(first.id))?.status).toBe('running');
        expect(activeRun?.status).toBe('running');
        expect((await TaskService.getById(second.id))?.status).toBe('pending');
        expect(worker.getRunningCount()).toBe(1);

        const failed = await waitForStatus(first.id, ['dead_letter'], 6_000);
        const completed = await waitForStatus(second.id, ['done'], 3_000);
        expect(failed.resultLog).toContain('任务超时');
        expect(completed.status).toBe('done');
        expect(isProcessAlive(descendantPid)).toBe(false);
    });

    test('guardian 被单独 SIGKILL 时隔离遗留进程组并阻止同批次重入', async () => {
        const fake = createOrphaningFakeOpencode();
        const first = await TaskService.add({
            name: 'guardian 意外退出任务',
            agent: 'test-agent',
            prompt: '保留同组后代',
            batchId: 'guardian-crash-batch',
            maxRetries: 0,
        });
        const second = await TaskService.add({
            name: '同批次不得重入',
            agent: 'test-agent',
            prompt: '必须等遗留进程组消失',
            batchId: 'guardian-crash-batch',
            maxRetries: 0,
        });
        const config = createConfig(10_000);
        config.worker.maxConcurrency = 2;
        const worker = new WorkerEngine(config, { opencodeBin: fake.executable });
        workers.push(worker);

        worker.start();
        await waitForStatus(first.id, ['running']);
        const pidDeadline = Date.now() + 3_000;
        while (!existsSync(fake.childPidFile) && Date.now() < pidDeadline) await Bun.sleep(20);
        expect(existsSync(fake.childPidFile)).toBe(true);
        const descendantPid = Number(readFileSync(fake.childPidFile, 'utf8'));
        const activeRun = await TaskRunService.getRunningRunByTaskId(first.id);
        expect(activeRun?.childPid).not.toBeNull();

        // 只杀 guardian 组长，不向负 PID 进程组发信号。
        process.kill(activeRun!.childPid!, 'SIGKILL');
        const guardianDeadline = Date.now() + 3_000;
        while (isProcessAlive(activeRun!.childPid!) && Date.now() < guardianDeadline) {
            await Bun.sleep(20);
        }
        await Bun.sleep(150);

        expect(isProcessAlive(activeRun!.childPid!)).toBe(false);
        expect(isProcessAlive(descendantPid)).toBe(true);
        expect((await TaskService.getById(first.id))?.status).toBe('running');
        expect((await TaskRunService.getById(activeRun!.id))?.status).toBe('running');
        expect((await TaskService.getById(second.id))?.status).toBe('pending');
        expect(worker.getRunningCount()).toBe(1);

        process.kill(descendantPid, 'SIGKILL');
        const descendantDeadline = Date.now() + 3_000;
        while (isProcessAlive(descendantPid) && Date.now() < descendantDeadline) {
            await Bun.sleep(20);
        }

        const failed = await waitForStatus(first.id, ['dead_letter'], 3_000);
        const completed = await waitForStatus(second.id, ['done'], 3_000);
        expect(failed.resultLog).toContain('guardian 未提供受管进程组排空证明');
        expect(completed.status).toBe('done');
    });

    test('取消终止已经开始时 stop 不夺取终态所有权', async () => {
        const fake = createFakeOpencode({ delayMs: 10_000, ignoreSigterm: true });
        const task = await TaskService.add({
            name: '取消与停机竞态',
            agent: 'test-agent',
            prompt: '取消终止期间触发停机',
            maxRetries: 0,
        });
        const worker = new WorkerEngine(createConfig(), { opencodeBin: fake.executable });
        workers.push(worker);

        worker.start();
        await waitForStatus(task.id, ['running']);
        await TaskService.cancel(task.id);
        const internals = worker as unknown as {
            runningTasks: Map<number, object>;
            cancelEntry(entry: object): Promise<void>;
        };
        const entry = internals.runningTasks.get(task.id);
        expect(entry).toBeDefined();

        const cancellation = internals.cancelEntry(entry!);
        const interrupted = await worker.stop();
        await cancellation;

        const runs = await TaskRunService.listByTaskId(task.id);
        expect(interrupted).toEqual([]);
        expect((await TaskService.getById(task.id))?.status).toBe('cancelled');
        expect(runs[0].status).toBe('failed');
        expect(runs[0].log).toContain('任务已取消');
    });

    test('失败终止已经开始时 stop 不覆盖失败终态', async () => {
        const fake = createFakeOpencode({ delayMs: 10_000, ignoreSigterm: true });
        const task = await TaskService.add({
            name: '超时与停机竞态',
            agent: 'test-agent',
            prompt: '超时终止期间触发停机',
            maxRetries: 0,
        });
        const worker = new WorkerEngine(createConfig(), { opencodeBin: fake.executable });
        workers.push(worker);

        worker.start();
        await waitForStatus(task.id, ['running']);
        const internals = worker as unknown as {
            runningTasks: Map<number, object>;
            terminateForFailure(
                entry: object,
                message: string,
                initialSignal: NodeJS.Signals,
            ): Promise<boolean>;
        };
        const entry = internals.runningTasks.get(task.id);
        expect(entry).toBeDefined();

        const timeout = internals.terminateForFailure(entry!, '任务超时（竞态测试）', 'SIGTERM');
        const interrupted = await worker.stop();
        expect(await timeout).toBe(true);

        const failed = await TaskService.getById(task.id);
        const runs = await TaskRunService.listByTaskId(task.id);
        expect(interrupted).toEqual([]);
        expect(failed?.status).toBe('dead_letter');
        expect(failed?.resultLog).toContain('任务超时（竞态测试）');
        expect(runs[0].status).toBe('failed');
    });

    test('异步结算失败被 Worker 捕获而不会产生 unhandledRejection', async () => {
        const fake = createFakeOpencode({ delayMs: 50 });
        const task = await TaskService.add({
            name: '结算异常隔离',
            agent: 'test-agent',
            prompt: '模拟数据库结算失败',
            maxRetries: 0,
        });
        const worker = new WorkerEngine(createConfig(), {
            opencodeBin: fake.executable,
            settlementRetryDelaysMs: [10, 20],
            settlementRetryIntervalMs: 20,
        });
        workers.push(worker);
        const originalCompleteRun = TaskService.completeRun;
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => unhandled.push(reason);
        process.on('unhandledRejection', onUnhandled);
        TaskService.completeRun = async () => {
            throw new Error('模拟结算写入失败');
        };

        try {
            worker.start();
            await waitForStatus(task.id, ['running']);
            await Bun.sleep(100);
            expect(unhandled).toEqual([]);
            expect(worker.getRunningCount()).toBe(1);
            expect((await TaskRunService.getRunningRunByTaskId(task.id))?.status).toBe('running');
            expect(await worker.stop()).toEqual([]);
            await waitForWorkerCount(worker, 0);
        } finally {
            TaskService.completeRun = originalCompleteRun;
            process.off('unhandledRejection', onUnhandled);
        }
    });

    test('临时结算失败时保持所有权并在短重试后成功', async () => {
        const fake = createFakeOpencode({ delayMs: 20 });
        const task = await TaskService.add({
            name: '结算短重试',
            agent: 'test-agent',
            prompt: '临时数据库故障后成功',
            maxRetries: 0,
        });
        const worker = new WorkerEngine(createConfig(), {
            opencodeBin: fake.executable,
            settlementRetryDelaysMs: [20, 20],
        });
        workers.push(worker);
        const originalCompleteRun = TaskService.completeRun;
        let attempts = 0;
        TaskService.completeRun = async (...args) => {
            attempts += 1;
            if (attempts < 3) throw new Error('模拟临时结算失败');
            return originalCompleteRun.apply(TaskService, args);
        };

        try {
            worker.start();
            await waitForStatus(task.id, ['running']);
            const deadline = Date.now() + 3_000;
            while (attempts < 2 && Date.now() < deadline) await Bun.sleep(10);
            expect(attempts).toBeGreaterThanOrEqual(2);
            expect(worker.getRunningCount()).toBe(1);

            const completed = await waitForStatus(task.id, ['done']);
            await waitForWorkerCount(worker, 0);
            expect(completed.status).toBe('done');
            expect(attempts).toBe(3);
        } finally {
            TaskService.completeRun = originalCompleteRun;
        }
    });

    test('停机宽限期内继续结算并保留成功结果', async () => {
        const fake = createFakeOpencode({ delayMs: 20 });
        const task = await TaskService.add({
            name: '停机结算宽限期',
            agent: 'test-agent',
            prompt: '宽限期内恢复数据库',
            maxRetries: 1,
        });
        const worker = new WorkerEngine(createConfig(), {
            opencodeBin: fake.executable,
            settlementRetryDelaysMs: [250],
            settlementRetryIntervalMs: 5_000,
        });
        workers.push(worker);
        const originalCompleteRun = TaskService.completeRun;
        let attempts = 0;
        let databaseAvailable = false;
        TaskService.completeRun = async (...args) => {
            attempts += 1;
            if (!databaseAvailable) throw new Error('模拟停机期间数据库不可用');
            return originalCompleteRun.apply(TaskService, args);
        };

        try {
            worker.start();
            await waitForStatus(task.id, ['running']);
            const deadline = Date.now() + 3_000;
            while (attempts === 0 && Date.now() < deadline) await Bun.sleep(10);
            expect(attempts).toBeGreaterThan(0);

            const stopping = worker.stop(100);
            await Bun.sleep(50);
            databaseAvailable = true;
            expect(await stopping).toEqual([]);
            expect(await TaskService.getById(task.id)).toMatchObject({ status: 'done' });
            expect(await TaskRunService.getRunningRunByTaskId(task.id)).toBeNull();
        } finally {
            TaskService.completeRun = originalCompleteRun;
        }
    });

    test('旧任务的 cwd 指向文件时不启动 OpenCode，并立即进入死信', async () => {
        const fake = createFakeOpencode({});
        const task = testDb.db.insert(testDb.schema.tasks).values({
            name: '旧版非法 cwd 测试',
            agent: 'test-agent',
            prompt: '不得启动',
            cwd: fake.executable,
            maxRetries: 3,
        }).returning().get();
        const worker = new WorkerEngine(createConfig(), { opencodeBin: fake.executable });
        workers.push(worker);

        worker.start();
        const failed = await waitForStatus(task.id, ['dead_letter']);
        const runs = await TaskRunService.listByTaskId(task.id);

        expect(failed.resultLog).toContain('任务工作目录不是目录');
        expect(failed.retryCount).toBe(1);
        expect(runs).toHaveLength(1);
        expect(runs[0].status).toBe('failed');
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

        expect(interrupted).toEqual([{ taskId: task.id, runId: 1 }]);
        expect(worker.getRunningCount()).toBe(0);
    });

    test('启动握手前父进程关闭管道时不会执行 OpenCode', async () => {
        const fake = createFakeOpencode({});
        const launcher = join(process.cwd(), 'src/worker/launcher.ts');
        const child = spawn(process.execPath, [launcher, fake.executable, 'run', '--agent', 'test-agent'], {
            stdio: ['pipe', 'ignore', 'ignore'],
        });
        child.stdin.end();
        const code = await new Promise<number | null>((resolve) => child.once('close', resolve));

        expect(code).toBe(125);
        expect(existsSync(fake.argsFile)).toBe(false);
    });

    test('launcher 发送绑定 drain proof 后等待 Worker 确认再退出', async () => {
        const launcher = join(process.cwd(), 'src/worker/launcher.ts');
        const launchIdentity = `gateway-${process.pid}:launch:123e4567-e89b-42d3-a456-426614174000`;
        const child = spawn(process.execPath, [
            launcher,
            LAUNCH_IDENTITY_ARGUMENT,
            launchIdentity,
            '/usr/bin/true',
        ], {
            detached: true,
            stdio: ['pipe', 'ignore', 'pipe', 'ipc'],
        });
        if (!child.pid || !child.stdin) throw new Error('无法启动 launcher IPC 测试');

        let stderr = '';
        child.stderr?.on('data', (data: Buffer) => {
            stderr += data.toString();
        });
        const proof = new Promise<unknown>((resolve) => child.once('message', resolve));
        child.stdin.end('START\n');

        const message = await proof;
        expect(isMatchingDrainProof(message, launchIdentity)).toBe(true);
        await Bun.sleep(50);
        expect(isProcessAlive(child.pid)).toBe(true);

        child.send(drainProofAckForIdentity(
            `gateway-${process.pid}:launch:123e4567-e89b-42d3-a456-426614174001`,
        ));
        await Bun.sleep(50);
        expect(isProcessAlive(child.pid)).toBe(true);

        child.send(drainProofAckForIdentity(launchIdentity));
        const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
            (resolve) => child.once('close', (code, signal) => resolve({ code, signal })),
        );
        expect(result).toEqual({ code: 0, signal: null });
        expect(stderr).toBe('');
    });

    test('进程组收到 SIGTERM 时 guardian 保持组长，直到 SIGKILL 清空忽略信号的后代', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'supertask-launcher-signal-test-'));
        tempDirs.push(dir);
        const executable = join(dir, 'ignore-sigterm-opencode');
        const childPidFile = join(dir, 'child.pid');
        writeFileSync(executable, `#!/usr/bin/env bun
import { writeFileSync } from 'fs';
writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid));
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`);
        chmodSync(executable, 0o755);
        const launcher = join(process.cwd(), 'src/worker/launcher.ts');
        const child = spawn(process.execPath, [launcher, executable], {
            detached: true,
            stdio: ['pipe', 'ignore', 'ignore'],
        });
        if (!child.pid || !child.stdin) throw new Error('无法启动 guardian 信号测试');

        try {
            child.stdin.end('START\n');
            const deadline = Date.now() + 3_000;
            while (!existsSync(childPidFile) && Date.now() < deadline) await Bun.sleep(20);
            expect(existsSync(childPidFile)).toBe(true);
            const descendantPid = Number(readFileSync(childPidFile, 'utf8'));

            process.kill(-child.pid, 'SIGTERM');
            await Bun.sleep(150);

            expect(isProcessAlive(child.pid)).toBe(true);
            expect(isProcessAlive(descendantPid)).toBe(true);

            expect(signalSpawnedProcessTree(child.pid, 'SIGKILL')).toBe(true);
            expect(await waitForSpawnedProcessTreeExit(child.pid, 3_000)).toBe(true);
        } finally {
            signalSpawnedProcessTree(child.pid, 'SIGKILL');
            await waitForSpawnedProcessTreeExit(child.pid, 3_000);
        }
    });

    test('OpenCode 自身被信号终止时 launcher 排空后保留 signal 退出语义', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'supertask-launcher-exit-signal-test-'));
        tempDirs.push(dir);
        const executable = join(dir, 'signal-opencode');
        writeFileSync(executable, `#!/usr/bin/env bun
process.kill(process.pid, 'SIGTERM');
`);
        chmodSync(executable, 0o755);
        const launcher = join(process.cwd(), 'src/worker/launcher.ts');
        const child = spawn(process.execPath, [launcher, executable], {
            detached: true,
            stdio: ['pipe', 'ignore', 'ignore'],
        });
        if (!child.stdin) throw new Error('无法启动 launcher signal 语义测试');

        child.stdin.end('START\n');
        const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
            child.once('close', (code, signal) => resolve({ code, signal }));
        });

        expect(result).toEqual({ code: null, signal: 'SIGTERM' });
    });

    test('重启后数据库中的运行任务继续占用全局并发额度', async () => {
        const fake = createFakeOpencode({});
        const existing = await TaskService.add({
            name: '旧 Gateway 正在执行',
            agent: 'test-agent',
            prompt: '不能与新任务并发',
        });
        await TaskService.start(existing.id);
        const existingRun = await TaskRunService.create({
            taskId: existing.id,
            status: 'running',
        });
        await TaskRunService.updatePid(existingRun.id, process.pid, process.pid);

        const pending = await TaskService.add({
            name: '等待全局额度',
            agent: 'test-agent',
            prompt: '必须保持等待',
        });
        const worker = new WorkerEngine(createConfig(), { opencodeBin: fake.executable });
        workers.push(worker);

        worker.start();
        await Bun.sleep(100);

        expect((await TaskService.getById(existing.id))!.status).toBe('running');
        expect((await TaskService.getById(pending.id))!.status).toBe('pending');
        expect(worker.getRunningCount()).toBe(0);
        expect(existsSync(fake.argsFile)).toBe(false);
    });
});
