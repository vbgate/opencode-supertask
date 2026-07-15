import { TaskService } from '@core/services/task.service';
import { TaskRunService } from '@core/services/task-run.service';
import { spawn, type ChildProcess } from 'child_process';
import type { GatewayConfig } from '@gateway/config';
import type { Task } from '@core/db/schema';

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
        this.poll();
        this.heartbeatTimer = setInterval(() => this.updateHeartbeats(), this.cfg.heartbeatIntervalMs);
    }

    stop(): Promise<void> {
        this.stopped = true;
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }

        const killPromises: Promise<void>[] = [];
        for (const entry of this.runningTasks.values()) {
            entry.shutdown = true;
            killPromises.push(this.killEntry(entry));
        }
        return Promise.allSettled(killPromises).then(() => {});
    }

    getRunningTaskIds(): number[] {
        return [...this.runningTasks.keys()];
    }

    getRunningCount(): number {
        return this.runningTasks.size;
    }

    private poll() {
        if (this.stopped) return;

        this.tryDispatch().then(() => {
            if (this.stopped) return;
            this.pollTimer = setTimeout(() => this.poll(), this.cfg.pollIntervalMs);
        });
    }

    private async tryDispatch() {
        while (!this.stopped && this.runningTasks.size < this.cfg.maxConcurrency) {
            let task: Task | null;
            try {
                task = await TaskService.next({ excludedBatchIds: [...this.activeBatchIds] });
            } catch (err) {
                this.logError('task claim failed', err);
                break;
            }
            if (!task) break;

            if (!await TaskService.start(task.id)) continue;
            if (task.batchId) this.activeBatchIds.add(task.batchId);

            try {
                const run = await TaskRunService.create({
                    taskId: task.id,
                    model: this.resolveModel(task.model),
                    status: 'running',
                });

                if (task.agent === FORBIDDEN_AGENT) {
                    const message = `禁止执行递归 Agent: ${FORBIDDEN_AGENT}`;
                    await TaskRunService.fail(run.id, message);
                    await TaskService.fail(task.id, message, {}, { setDeadLetter: true });
                    this.releaseBatch(task);
                    continue;
                }

                this.spawnTask(task, run.id);
            } catch (err) {
                this.releaseBatch(task);
                const message = `Worker 启动任务失败：${err instanceof Error ? err.message : String(err)}`;
                try {
                    await TaskService.fail(task.id, message);
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
            process.stdout.write(text);

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
        this.runningTasks.delete(entry.task.id);
        this.releaseBatch(entry.task);

        if (entry.shutdown) return;

        const currentRun = await TaskRunService.getById(entry.runId);
        if (!currentRun || currentRun.status !== 'running') return;

        const output = entry.output.trim();
        const log = failure
            ? `${failure}${output ? `\n${output}` : ''}`
            : output;

        if (code === 0 && !failure) {
            const completed = await TaskService.done(entry.task.id, log);
            if (completed) {
                await TaskRunService.done(entry.runId, log);
                console.log(JSON.stringify({
                    ts: new Date().toISOString(),
                    level: 'info',
                    msg: 'task done',
                    taskId: entry.task.id,
                }));
                return;
            }

            await TaskRunService.fail(entry.runId, '任务状态已被其他操作改变');
            return;
        }

        await TaskRunService.fail(entry.runId, log);
        const failed = await TaskService.fail(entry.task.id, log);
        if (!failed) {
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

        if (process.platform !== 'win32') {
            try {
                process.kill(-pid, signal);
                return;
            } catch {
            }
        }

        try {
            entry.child.kill(signal);
        } catch {
        }
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
