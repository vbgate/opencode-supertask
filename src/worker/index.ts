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
import { signalSpawnedProcessTree } from '@core/process-control';

const DEFAULT_MAX_OUTPUT_CHARS = 64 * 1024;
const FORBIDDEN_AGENT = 'supertask-runner';

interface WorkerEngineOptions {
    opencodeBin?: string;
    maxOutputChars?: number;
}

interface RunningTask {
    task: Task;
    runId: number;
    child: ChildProcess;
    output: string;
    sessionId: string | null;
    timeoutTimer: ReturnType<typeof setTimeout> | null;
    shutdown: boolean;
    settled: boolean;
}

export class WorkerEngine {
    private activeBatchIds = new Set<string>();
    private runningTasks = new Map<number, RunningTask>();
    private stopped = false;
    private pollTimer: ReturnType<typeof setTimeout> | null = null;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private pollCyclePromise: Promise<void> | null = null;
    private cfg: GatewayConfig['worker'];
    private opencodeBin: string;
    private maxOutputChars: number;

    constructor(cfg: GatewayConfig, options: WorkerEngineOptions = {}) {
        this.cfg = cfg.worker;
        this.opencodeBin = options.opencodeBin ?? process.env.SUPERTASK_OPENCODE_BIN ?? 'opencode';
        this.maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
    }

    start() {
        this.stopped = false;
        markGatewayActivity('worker');
        this.poll();
        this.heartbeatTimer = setInterval(() => this.updateHeartbeats(), this.cfg.heartbeatIntervalMs);
    }

    async stop(gracePeriodMs = 0): Promise<number[]> {
        this.stopped = true;
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

        const interruptedTaskIds = [...this.runningTasks.keys()];
        const killPromises: Promise<void>[] = [];
        for (const entry of this.runningTasks.values()) {
            entry.shutdown = true;
            killPromises.push(this.killEntry(entry));
        }
        await Promise.allSettled(killPromises);
        return interruptedTaskIds;
    }

    getRunningTaskIds(): number[] {
        return [...this.runningTasks.keys()];
    }

    getRunningCount(): number {
        return this.runningTasks.size;
    }

    private poll() {
        if (this.stopped) return;
        markGatewayActivity('worker');

        this.pollCyclePromise = this.tryDispatch()
            .then(() => markGatewaySuccess('worker'))
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

    private async tryDispatch() {
        await TaskService.resolveBlockedDependencies();
        await TaskService.resetOrphanRunningToPending();
        await this.reconcileCancelledTasks();

        while (!this.stopped && this.runningTasks.size < this.cfg.maxConcurrency) {
            const databaseRunningCount = await TaskService.countRunning();
            if (databaseRunningCount >= this.cfg.maxConcurrency) break;

            let task: Task | null;
            try {
                task = await TaskService.next({ excludedBatchIds: [...this.activeBatchIds] });
            } catch (err) {
                this.logError('task claim failed', err);
                throw err;
            }
            if (!task) break;
            if (this.stopped) break;

            if (!await TaskService.start(task.id)) continue;
            if (task.batchId) this.activeBatchIds.add(task.batchId);

            if (this.stopped) {
                await TaskService.resetRunningToPending([task.id]);
                this.releaseBatch(task);
                break;
            }

            let runId: number | null = null;
            try {
                const run = await TaskRunService.create({
                    taskId: task.id,
                    model: this.resolveModel(task.model),
                    status: 'running',
                    workerPid: process.pid,
                    lockedAt: Date.now(),
                    lockedBy: `gateway-${process.pid}`,
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

                this.spawnTask(task, run.id);
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
    }

    private spawnTask(task: Task, runId: number) {
        const model = this.resolveModel(task.model);
        const args = ['run', '--agent', task.agent, '--format', 'json'];
        if (model) args.push('-m', model);
        args.push(task.prompt);

        const child = spawn(this.opencodeBin, args, {
            cwd: task.cwd || process.cwd(),
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: process.platform !== 'win32',
        });
        const entry: RunningTask = {
            task,
            runId,
            child,
            output: '',
            sessionId: null,
            timeoutTimer: null,
            shutdown: false,
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
        child.once('error', (err) => {
            void this.finishEntry(entry, null, `无法启动 opencode：${err.message}`);
        });
        child.once('close', (code, signal) => {
            const failure = code === 0
                ? undefined
                : `opencode 退出码 ${code ?? 'null'}${signal ? `，信号 ${signal}` : ''}`;
            void this.finishEntry(entry, code, failure);
        });

        const timeoutMs = task.timeoutMs ?? this.cfg.taskTimeoutMs;
        if (timeoutMs > 0) {
            entry.timeoutTimer = setTimeout(() => {
                this.signalEntry(entry, 'SIGKILL');
                void this.finishEntry(entry, null, `任务超时（${timeoutMs}ms）`);
            }, timeoutMs);
        }

        TaskRunService.updatePid(runId, process.pid, child.pid ?? 0).catch((err) => {
            this.signalEntry(entry, 'SIGKILL');
            void this.finishEntry(entry, null, `记录 Worker PID 失败：${err instanceof Error ? err.message : String(err)}`);
        });
    }

    private async finishEntry(entry: RunningTask, code: number | null, failure?: string) {
        if (entry.settled) return;
        entry.settled = true;
        if (entry.timeoutTimer) {
            clearTimeout(entry.timeoutTimer);
            entry.timeoutTimer = null;
        }
        try {
            if (entry.shutdown) return;

            const currentRun = await TaskRunService.getById(entry.runId);
            if (!currentRun || currentRun.status !== 'running') return;

            const output = entry.output.trim();
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
        } finally {
            this.runningTasks.delete(entry.task.id);
            this.releaseBatch(entry.task);
        }
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

    private async cancelEntry(entry: RunningTask) {
        if (entry.settled) return;
        entry.settled = true;
        if (entry.timeoutTimer) {
            clearTimeout(entry.timeoutTimer);
            entry.timeoutTimer = null;
        }

        try {
            await this.killEntry(entry);
            const output = entry.output.trim();
            const log = `任务已取消${output ? `\n${output}` : ''}`;
            await TaskRunService.fail(entry.runId, log);
            console.log(JSON.stringify({
                ts: new Date().toISOString(),
                level: 'info',
                msg: 'running task cancelled',
                taskId: entry.task.id,
            }));
        } finally {
            this.runningTasks.delete(entry.task.id);
            this.releaseBatch(entry.task);
        }
    }

    private async updateHeartbeats() {
        for (const entry of this.runningTasks.values()) {
            try {
                await TaskRunService.heartbeat(entry.runId);
            } catch (err) {
                this.logError('heartbeat update failed', err, entry.task.id);
            }
        }
    }

    private killEntry(entry: RunningTask): Promise<void> {
        if (entry.child.exitCode !== null || entry.child.signalCode !== null) {
            return Promise.resolve();
        }

        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                this.signalEntry(entry, 'SIGKILL');
                resolve();
            }, 5_000);

            entry.child.once('close', () => {
                clearTimeout(timeout);
                resolve();
            });

            this.signalEntry(entry, 'SIGTERM');
        });
    }

    private signalEntry(entry: RunningTask, signal: NodeJS.Signals) {
        const pid = entry.child.pid;
        if (!pid) return;

        signalSpawnedProcessTree(pid, signal);
    }

    private releaseBatch(task: Task) {
        if (task.batchId) this.activeBatchIds.delete(task.batchId);
    }

    private resolveModel(taskModel: string | null): string | null {
        if (!taskModel || taskModel === 'default') return null;
        return taskModel;
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
