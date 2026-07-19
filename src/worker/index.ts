import { TaskService } from '@core/services/task.service';
import { TaskRunService } from '@core/services/task-run.service';
import { spawn, type ChildProcess } from 'child_process';
import type { GatewayConfig } from '@gateway/config';
import type { Task } from '@core/db/schema';
import {
    markGatewayActivity,
    markGatewayFailure,
    markGatewaySuccess,
} from '@gateway/health';
import {
    inspectSpawnedProcessTreePresence,
    signalRecordedProcessTreeWithResult,
    waitForSpawnedProcessTreeExit,
} from '@core/process-control';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';
import {
    drainProofAckForIdentity,
    isMatchingDrainProof,
    LAUNCH_IDENTITY_ARGUMENT,
    MANAGED_RUN_ENV,
    MANAGED_RUN_ENV_VALUE,
    TOKEN_GUARDIAN_LAUNCH_PROTOCOL,
} from '@core/launch-protocol';
import { validateTaskWorkingDirectory } from '@core/task-working-directory';
import { normalizeTaskBatchId } from '@core/task-batch';

const DEFAULT_MAX_OUTPUT_CHARS = 64 * 1024;
const FORBIDDEN_AGENT = 'supertask-runner';

interface WorkerEngineOptions {
    opencodeBin?: string;
    maxOutputChars?: number;
    settlementRetryDelaysMs?: number[];
    settlementRetryIntervalMs?: number;
}

interface TaskTermination {
    kind: 'cancel' | 'failure' | 'shutdown';
    message: string;
}

interface RunningTask {
    task: Task;
    runId: number;
    launchIdentity: string;
    child: ChildProcess;
    commandContext: string;
    output: string;
    sessionId: string | null;
    timeoutTimer: ReturnType<typeof setTimeout> | null;
    termination: TaskTermination | null;
    terminationPromise: Promise<boolean> | null;
    settlementPromise: Promise<boolean> | null;
    guardianDrained: boolean;
    quarantined: boolean;
    settled: boolean;
}

export interface InterruptedTaskRun {
    taskId: number;
    runId: number;
}

export function runCommandContext(executable: string, args: string[], cwd: string): string {
    return JSON.stringify({
        type: 'supertask_command',
        executable,
        args,
        cwd,
    });
}

export function assertWorkerProcessIsolationSupported(
    platform: NodeJS.Platform = process.platform,
): void {
    if (platform === 'win32') {
        throw new Error(
            'Windows Worker 已安全禁用：当前运行时无法用 Job Object 提供等价的受管进程隔离与排空证明',
        );
    }
}

export class WorkerEngine {
    private activeBatchIds = new Set<string>();
    private runningTasks = new Map<number, RunningTask>();
    private stopped = false;
    private pollTimer: ReturnType<typeof setTimeout> | null = null;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private pollCyclePromise: Promise<void> | null = null;
    private shutdownDeadlineMs: number | null = null;
    private settlementRetryWakeups = new Set<() => void>();
    private cfg: GatewayConfig['worker'];
    private opencodeBin: string;
    private maxOutputChars: number;
    private settlementRetryDelaysMs: number[];
    private settlementRetryIntervalMs: number;

    constructor(cfg: GatewayConfig, options: WorkerEngineOptions = {}) {
        this.cfg = cfg.worker;
        this.opencodeBin = options.opencodeBin ?? process.env.SUPERTASK_OPENCODE_BIN ?? 'opencode';
        this.maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
        this.settlementRetryDelaysMs = options.settlementRetryDelaysMs ?? [250, 1_000, 4_000];
        this.settlementRetryIntervalMs = options.settlementRetryIntervalMs ?? 5_000;
    }

    start() {
        assertWorkerProcessIsolationSupported();
        this.stopped = false;
        this.shutdownDeadlineMs = null;
        markGatewayActivity('worker');
        this.poll();
        this.heartbeatTimer = setInterval(() => {
            this.runDetached(this.updateHeartbeats(), 'worker heartbeat cycle failed');
        }, this.cfg.heartbeatIntervalMs);
    }

    async stop(gracePeriodMs = 0): Promise<InterruptedTaskRun[]> {
        this.stopped = true;
        this.shutdownDeadlineMs = Date.now() + Math.max(0, gracePeriodMs);
        for (const wake of [...this.settlementRetryWakeups]) wake();
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }

        if (this.pollCyclePromise) await this.pollCyclePromise;

        if (gracePeriodMs > 0 && this.runningTasks.size > 0) {
            const deadline = Date.now() + gracePeriodMs;
            while (this.runningTasks.size > 0 && Date.now() < deadline) {
                await Bun.sleep(Math.min(50, deadline - Date.now()));
            }
        }

        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }

        const interrupted: InterruptedTaskRun[] = [];
        const entries = [...this.runningTasks.values()];
        await Promise.all(entries.map(async (entry) => {
            if (entry.settled) {
                if (entry.settlementPromise) await entry.settlementPromise;
                return;
            }

            const termination = entry.termination ?? {
                kind: 'shutdown' as const,
                message: 'Gateway shutdown',
            };
            const terminated = await this.terminateEntry(entry, termination);
            if (terminated && termination.kind === 'shutdown') {
                interrupted.push({ taskId: entry.task.id, runId: entry.runId });
            }
        }));
        return interrupted;
    }

    getRunningTaskIds(): number[] {
        return [...this.runningTasks.keys()];
    }

    getRunningCount(): number {
        return this.runningTasks.size;
    }

    ownsRun(taskId: number, runId: number): boolean {
        return this.runningTasks.get(taskId)?.runId === runId;
    }

    private poll() {
        if (this.stopped) return;
        markGatewayActivity('worker');

        this.pollCyclePromise = this.tryDispatch()
            .then((healthy) => {
                if (healthy) markGatewaySuccess('worker');
            })
            .catch((err) => {
                markGatewayFailure('worker', err);
                this.logError('worker poll failed', err);
            })
            .finally(() => {
                this.pollCyclePromise = null;
                if (this.stopped) return;
                this.pollTimer = setTimeout(() => this.poll(), this.cfg.pollIntervalMs);
            });
    }

    private async tryDispatch(): Promise<boolean> {
        await TaskService.resetOrphanRunningToPending();
        await this.reconcileCancelledTasks();
        await this.reconcileQuarantinedTasks();

        const quarantined = [...this.runningTasks.values()].filter((entry) => entry.quarantined);
        if (quarantined.length > 0) {
            return false;
        }

        while (!this.stopped && this.runningTasks.size < this.cfg.maxConcurrency) {
            const databaseRunningCount = await TaskService.countRunning();
            if (databaseRunningCount >= this.cfg.maxConcurrency) break;

            let task: Task | null;
            try {
                task = await TaskService.claimNext({ excludedBatchIds: [...this.activeBatchIds] });
            } catch (err) {
                this.logError('task claim failed', err);
                throw err;
            }
            if (!task) break;
            if (this.stopped) {
                await TaskService.resetRunningToPending([task.id]);
                break;
            }

            const batchId = normalizeTaskBatchId(task.batchId);
            if (batchId) this.activeBatchIds.add(batchId);

            let runId: number | null = null;
            try {
                const launchIdentity = `gateway-${process.pid}:launch:${randomUUID()}`;
                const run = await TaskRunService.create({
                    taskId: task.id,
                    model: this.resolveModel(task.model),
                    variant: this.resolveVariant(task.variant),
                    status: 'running',
                    workerPid: process.pid,
                    lockedAt: Date.now(),
                    lockedBy: launchIdentity,
                    launchProtocol: TOKEN_GUARDIAN_LAUNCH_PROTOCOL,
                });
                runId = run.id;

                if (this.stopped) {
                    await TaskRunService.fail(run.id, 'Gateway shutdown before spawn');
                    await TaskService.resetRunningToPending([task.id]);
                    this.releaseBatch(task);
                    break;
                }

                if (task.agent === FORBIDDEN_AGENT) {
                    const message = `禁止执行递归 Agent: ${FORBIDDEN_AGENT}`;
                    await TaskService.failRun(task.id, run.id, message, { setDeadLetter: true });
                    this.releaseBatch(task);
                    continue;
                }

                try {
                    validateTaskWorkingDirectory(task.cwd);
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    await TaskService.failRun(task.id, run.id, message, { setDeadLetter: true });
                    this.releaseBatch(task);
                    continue;
                }

                await this.spawnTask(task, run.id, launchIdentity);
            } catch (err) {
                this.releaseBatch(task);
                const message = `Worker 启动任务失败：${err instanceof Error ? err.message : String(err)}`;
                try {
                    if (runId == null) {
                        await TaskService.fail(task.id, message);
                    } else {
                        const failed = await TaskService.failRun(task.id, runId, message);
                        if (!failed) {
                            await TaskRunService.fail(runId, `${message}\n任务状态已被其他操作改变`);
                        }
                    }
                } catch (failErr) {
                    this.logError('failed to compensate task startup', failErr, task.id);
                }
                this.logError('task dispatch failed', err, task.id);
            }
        }
        return ![...this.runningTasks.values()].some((entry) => entry.quarantined);
    }

    private launcherEntry(): string {
        const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
        const moduleDir = dirname(fileURLToPath(import.meta.url));
        const candidates = [
            join(moduleDir, `launcher.${extension}`),
            join(moduleDir, `../worker/launcher.${extension}`),
        ];
        const entry = candidates.find((candidate) => existsSync(candidate));
        if (!entry) throw new Error(`Worker launcher 不存在：${candidates.join(', ')}`);
        return entry;
    }

    private async spawnTask(task: Task, runId: number, launchIdentity: string): Promise<void> {
        const model = this.resolveModel(task.model);
        const variant = this.resolveVariant(task.variant);
        const args = ['run', '--agent', task.agent, '--format', 'json'];
        if (model) args.push('-m', model);
        if (variant) args.push('--variant', variant);
        args.push(task.prompt);
        const cwd = task.cwd || process.cwd();

        const child = spawn(process.execPath, [
            this.launcherEntry(),
            LAUNCH_IDENTITY_ARGUMENT,
            launchIdentity,
            this.opencodeBin,
            ...args,
        ], {
            cwd,
            env: {
                ...process.env,
                PWD: cwd,
                [MANAGED_RUN_ENV]: MANAGED_RUN_ENV_VALUE,
            },
            stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
            detached: process.platform !== 'win32',
        });
        const entry: RunningTask = {
            task,
            runId,
            launchIdentity,
            child,
            commandContext: runCommandContext(this.opencodeBin, args, cwd),
            output: '',
            sessionId: null,
            timeoutTimer: null,
            termination: null,
            terminationPromise: null,
            settlementPromise: null,
            guardianDrained: false,
            quarantined: false,
            settled: false,
        };
        this.runningTasks.set(task.id, entry);

        const handleData = (data: Buffer) => {
            const text = data.toString();
            entry.output = (entry.output + text).slice(-this.maxOutputChars);

            const match = entry.output.match(/"sessionID"\s*:\s*"(ses_[^"]+)"/);
            if (match?.[1] && match[1] !== entry.sessionId) {
                entry.sessionId = match[1];
                TaskRunService.updateSessionId(runId, match[1]).catch((err) => {
                    this.logError('sessionId update failed', err, task.id);
                });
            }
        };
        child.stdout?.on('data', handleData);
        child.stderr?.on('data', handleData);
        child.on('message', (message: unknown) => {
            if (isMatchingDrainProof(message, entry.launchIdentity)) {
                entry.guardianDrained = true;
                try {
                    child.send(drainProofAckForIdentity(entry.launchIdentity));
                } catch (error) {
                    this.logError('drain proof acknowledgment failed', error, task.id);
                }
            }
        });
        let spawnError: Error | null = null;
        const spawned = new Promise<void>((resolve, reject) => {
            child.once('spawn', resolve);
            child.once('error', (error) => {
                spawnError = error;
                reject(error);
            });
        });
        child.once('close', (code, signal) => {
            this.handleChildClose(entry, code, signal, spawnError);
        });

        try {
            await spawned;
        } catch (error) {
            entry.settled = true;
            this.runningTasks.delete(task.id);
            this.releaseBatch(task);
            throw error;
        }

        const childPid = child.pid;
        if (!childPid) {
            entry.settled = true;
            this.runningTasks.delete(task.id);
            this.releaseBatch(task);
            throw new Error('launcher 未返回 PID');
        }

        let pidRecorded = false;
        try {
            pidRecorded = await TaskRunService.updatePid(
                runId,
                process.pid,
                childPid,
                launchIdentity,
            ) !== null;
        } catch (error) {
            await this.terminateForFailure(
                entry,
                `记录 Worker PID 失败：${error instanceof Error ? error.message : String(error)}`,
            );
            return;
        }
        if (!pidRecorded) {
            await this.terminateForFailure(entry, '记录 Worker PID 失败：run 已不再处于 running 状态');
            return;
        }

        if (!child.stdin) {
            await this.terminateForFailure(entry, '放行 OpenCode 失败：launcher stdin 不可用');
            return;
        }
        try {
            await new Promise<void>((resolve, reject) => {
                child.stdin!.end('START\n', (error?: Error | null) => {
                    if (error) reject(error);
                    else resolve();
                });
            });
        } catch (error) {
            await this.terminateForFailure(
                entry,
                `放行 OpenCode 失败：${error instanceof Error ? error.message : String(error)}`,
            );
            return;
        }

        const timeoutMs = task.timeoutMs ?? this.cfg.taskTimeoutMs;
        if (timeoutMs > 0) {
            entry.timeoutTimer = setTimeout(() => {
                this.runDetached(
                    this.terminateForFailure(entry, `任务超时（${timeoutMs}ms）`, 'SIGKILL'),
                    'timeout termination failed',
                    entry.task.id,
                );
            }, timeoutMs);
        }
    }

    private handleChildClose(
        entry: RunningTask,
        code: number | null,
        signal: NodeJS.Signals | null,
        spawnError: Error | null,
    ): void {
        if (entry.settled || entry.termination) return;

        if (!entry.guardianDrained) {
            const pid = entry.child.pid;
            const presence = pid == null
                ? spawnError == null ? 'unknown' : 'not-running'
                : inspectSpawnedProcessTreePresence(pid);
            const message = 'guardian 未提供受管进程组排空证明';
            if (presence !== 'not-running') {
                if (entry.timeoutTimer) {
                    clearTimeout(entry.timeoutTimer);
                    entry.timeoutTimer = null;
                }
                entry.termination = { kind: 'failure', message };
                entry.quarantined = true;
                markGatewayFailure(
                    'worker',
                    new Error(`${message}；任务 #${entry.task.id} 保持隔离`),
                );
                return;
            }
            this.runDetached(
                this.settleEntry(entry, null, message),
                'task settlement failed',
                entry.task.id,
            );
            return;
        }

        const failure = code === 0
            ? undefined
            : `${spawnError ? '无法启动 opencode' : 'opencode 退出码'} ${spawnError?.message ?? code ?? 'null'}${signal ? `，信号 ${signal}` : ''}`
                + `（agent=${entry.task.agent}，model=${this.resolveModel(entry.task.model) ?? 'Agent/默认配置'}，variant=${this.resolveVariant(entry.task.variant) ?? 'Agent/模型默认配置'}，cwd=${entry.task.cwd ?? process.cwd()}）`;
        this.runDetached(
            this.settleEntry(entry, code, failure),
            'task settlement failed',
            entry.task.id,
        );
    }

    private settleEntry(
        entry: RunningTask,
        code: number | null,
        failure?: string,
    ): Promise<boolean> {
        if (entry.settlementPromise) return entry.settlementPromise;
        if (entry.settled) return Promise.resolve(false);
        entry.settled = true;
        if (entry.timeoutTimer) {
            clearTimeout(entry.timeoutTimer);
            entry.timeoutTimer = null;
        }

        const settlement = this.commitEntryWithRetry(entry, code, failure)
            .finally(() => {
                this.runningTasks.delete(entry.task.id);
                this.releaseBatch(entry.task);
            });
        entry.settlementPromise = settlement;
        return settlement;
    }

    private async commitEntryWithRetry(
        entry: RunningTask,
        code: number | null,
        failure?: string,
    ): Promise<boolean> {
        for (let attempt = 0; ; attempt += 1) {
            try {
                await this.commitEntry(entry, code, failure);
                return true;
            } catch (error) {
                markGatewayFailure('worker', error);
                const shortRetryDelayMs = this.settlementRetryDelaysMs[attempt];
                let retryDelayMs = shortRetryDelayMs ?? this.settlementRetryIntervalMs;
                if (this.stopped) {
                    const remainingMs = Math.max(0, (this.shutdownDeadlineMs ?? 0) - Date.now());
                    if (remainingMs === 0) return false;
                    retryDelayMs = Math.min(retryDelayMs, remainingMs);
                }
                this.logError(
                    `task settlement failed; retrying in ${retryDelayMs}ms`,
                    error,
                    entry.task.id,
                );
                await this.waitForSettlementRetry(retryDelayMs);
            }
        }
    }

    private waitForSettlementRetry(delayMs: number): Promise<void> {
        return new Promise((resolve) => {
            let timer: ReturnType<typeof setTimeout>;
            const finish = () => {
                clearTimeout(timer);
                this.settlementRetryWakeups.delete(finish);
                resolve();
            };
            timer = setTimeout(finish, delayMs);
            this.settlementRetryWakeups.add(finish);
        });
    }

    private async commitEntry(
        entry: RunningTask,
        code: number | null,
        failure?: string,
    ): Promise<void> {
        const termination = entry.termination;
        if (termination?.kind === 'shutdown') return;

        if (termination?.kind === 'cancel') {
            const output = this.outputWithCommand(entry);
            const log = `${termination.message}${output ? `\n${output}` : ''}`;
            await TaskRunService.fail(entry.runId, log);
            console.log(JSON.stringify({
                ts: new Date().toISOString(),
                level: 'info',
                msg: 'running task cancelled',
                taskId: entry.task.id,
            }));
            return;
        }

        const currentRun = await TaskRunService.getById(entry.runId);
        if (!currentRun || currentRun.status !== 'running') return;

        const output = this.outputWithCommand(entry);
        const log = failure
            ? `${failure}${output ? `\n${output}` : ''}`
            : output;

        if (code === 0 && !failure) {
            const completed = await TaskService.completeRun(entry.task.id, entry.runId, log);
            if (completed) {
                console.log(JSON.stringify({
                    ts: new Date().toISOString(),
                    level: 'info',
                    msg: 'task done',
                    taskId: entry.task.id,
                }));
                return;
            }

            await TaskRunService.fail(entry.runId, '任务或执行记录状态已被其他操作改变');
            return;
        }

        const failed = await TaskService.failRun(entry.task.id, entry.runId, log);
        if (!failed) {
            await TaskRunService.fail(
                entry.runId,
                `${log}${log ? '\n' : ''}任务状态已被其他操作改变`,
            );
            this.logError('task failure state transition rejected', failure ?? 'unknown failure', entry.task.id);
        }
        console.error(JSON.stringify({
            ts: new Date().toISOString(),
            level: 'error',
            msg: 'task failed',
            taskId: entry.task.id,
            error: failure,
        }));
    }

    private async reconcileCancelledTasks() {
        for (const entry of [...this.runningTasks.values()]) {
            try {
                const task = await TaskService.getById(entry.task.id);
                if (task?.status === 'cancelled') await this.cancelEntry(entry);
            } catch (err) {
                this.logError('cancel reconciliation failed', err, entry.task.id);
            }
        }
    }

    private async reconcileQuarantinedTasks() {
        for (const entry of [...this.runningTasks.values()]) {
            if (!entry.quarantined || !entry.termination) continue;
            await this.terminateEntry(entry, entry.termination);
        }
    }

    private async cancelEntry(entry: RunningTask) {
        await this.terminateEntry(entry, { kind: 'cancel', message: '任务已取消' });
    }

    private async updateHeartbeats() {
        for (const entry of this.runningTasks.values()) {
            if (entry.quarantined) continue;
            try {
                await TaskRunService.heartbeat(entry.runId);
            } catch (err) {
                this.logError('heartbeat update failed', err, entry.task.id);
            }
        }
    }

    private async terminateForFailure(
        entry: RunningTask,
        message: string,
        initialSignal: NodeJS.Signals = 'SIGTERM',
    ): Promise<boolean> {
        return this.terminateEntry(entry, { kind: 'failure', message }, initialSignal);
    }

    private terminateEntry(
        entry: RunningTask,
        termination: TaskTermination,
        initialSignal: NodeJS.Signals = 'SIGTERM',
    ): Promise<boolean> {
        if (entry.terminationPromise) return entry.terminationPromise;
        if (entry.settled) return entry.settlementPromise ?? Promise.resolve(false);

        entry.termination ??= termination;
        if (entry.timeoutTimer) {
            clearTimeout(entry.timeoutTimer);
            entry.timeoutTimer = null;
        }
        entry.quarantined = true;

        const terminationPromise = this.completeTermination(entry, initialSignal)
            .finally(() => {
                if (!entry.settled && entry.terminationPromise === terminationPromise) {
                    entry.terminationPromise = null;
                }
            });
        entry.terminationPromise = terminationPromise;
        return terminationPromise;
    }

    private async completeTermination(
        entry: RunningTask,
        initialSignal: NodeJS.Signals,
    ): Promise<boolean> {
        const termination = entry.termination;
        if (!termination) return false;

        try {
            const exited = await this.killEntry(entry, initialSignal);
            if (!exited) {
                markGatewayFailure(
                    'worker',
                    new Error(`${termination.message}；任务 #${entry.task.id} 的进程无法确认退出`),
                );
                return false;
            }
            entry.quarantined = false;
            return await this.settleEntry(
                entry,
                null,
                termination.kind === 'failure' ? termination.message : undefined,
            );
        } catch (error) {
            markGatewayFailure('worker', error);
            this.logError('task termination failed', error, entry.task.id);
            return false;
        }
    }

    private async killEntry(
        entry: RunningTask,
        initialSignal: NodeJS.Signals = 'SIGTERM',
    ): Promise<boolean> {
        // 只有绑定当前 run 身份的独立 IPC 证明才能把 guardian 退出视为整组排空。
        if (entry.guardianDrained
            && (entry.child.exitCode !== null || entry.child.signalCode !== null)) return true;
        const pid = entry.child.pid;
        if (!pid) return false;

        const initialResult = this.signalEntry(entry, initialSignal);
        if (initialResult === 'not-running') return true;
        if (initialResult !== 'signalled') return false;
        if (await waitForSpawnedProcessTreeExit(pid, 2_500)) return true;
        if (initialSignal === 'SIGKILL') return false;
        if (entry.guardianDrained
            && (entry.child.exitCode !== null || entry.child.signalCode !== null)) return true;

        const forcedResult = this.signalEntry(entry, 'SIGKILL');
        if (forcedResult === 'not-running') return true;
        if (forcedResult !== 'signalled') return false;
        return waitForSpawnedProcessTreeExit(pid, 2_500);
    }

    private signalEntry(entry: RunningTask, signal: NodeJS.Signals) {
        const pid = entry.child.pid;
        if (!pid) return 'not-running' as const;

        return signalRecordedProcessTreeWithResult(
            pid,
            signal,
            this.opencodeBin,
            TOKEN_GUARDIAN_LAUNCH_PROTOCOL,
            entry.launchIdentity,
        );
    }

    private releaseBatch(task: Task) {
        const batchId = normalizeTaskBatchId(task.batchId);
        if (batchId) this.activeBatchIds.delete(batchId);
    }

    private outputWithCommand(entry: RunningTask): string {
        const output = entry.output.trim();
        return `${entry.commandContext}${output ? `\n${output}` : ''}`;
    }

    private resolveModel(taskModel: string | null): string | null {
        if (!taskModel || taskModel === 'default') return null;
        return taskModel;
    }

    private resolveVariant(taskVariant: string | null): string | null {
        return taskVariant?.trim() || null;
    }

    private runDetached(operation: Promise<unknown>, message: string, taskId?: number): void {
        operation.catch((error) => {
            markGatewayFailure('worker', error);
            this.logError(message, error, taskId);
        });
    }

    private logError(message: string, error: unknown, taskId?: number) {
        console.error(JSON.stringify({
            ts: new Date().toISOString(),
            level: 'error',
            msg: message,
            taskId,
            error: error instanceof Error ? error.message : String(error),
        }));
    }
}
