import { TaskService } from '@core/services/task.service';
import { TaskRunService } from '@core/services/task-run.service';
import { spawn, type ChildProcess } from 'child_process';
import type { GatewayConfig } from '@gateway/config';
import type { Task } from '@core/db/schema';

interface RunningTask {
    task: Task;
    runId: number;
    child: ChildProcess;
    startedAt: number;
    shutdown: boolean;
}

export class WorkerEngine {
    private activeBatchIds = new Set<string>();
    private runningTasks = new Map<number, RunningTask>();
    private stopped = false;
    private pollTimer: ReturnType<typeof setTimeout> | null = null;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private cfg: GatewayConfig['worker'];

    constructor(cfg: GatewayConfig) {
        this.cfg = cfg.worker;
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
        for (const [, entry] of this.runningTasks) {
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
            try {
                const excludedBatchIds = [...this.activeBatchIds];
                const task = await TaskService.next({ excludedBatchIds });
                if (!task) break;

                if (!await TaskService.start(task.id)) continue;

                if (task.batchId) {
                    this.activeBatchIds.add(task.batchId);
                }

                const run = await TaskRunService.create({
                    taskId: task.id,
                    model: this.resolveModel(task.model),
                    status: 'running',
                });

                const modelToUse = this.resolveModel(task.model);
                const modelArg = modelToUse ? ` -m "${modelToUse}"` : '';
                const cmd = `opencode run --agent supertask-runner${modelArg} --format json "执行任务 ID: ${task.id}${modelToUse ? ` OVERRIDE_MODEL=${modelToUse}` : ''}"`;
                const cwd = task.cwd || process.cwd();

                const child = spawn('sh', ['-c', cmd], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

                await TaskRunService.updatePid(run.id, process.pid, child.pid ?? 0);

                let output = '';
                const handleData = (data: Buffer) => {
                    const text = data.toString();
                    output += text;
                    process.stdout.write(text);

                    const match = text.match(/"sessionID"\s*:\s*"(ses_[^"]+)"/);
                    if (match) {
                        TaskRunService.updateSessionId(run.id, match[1]).then(() => {
                            console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg: 'sessionId captured', taskId: task.id, sessionId: match[1] }));
                        });
                    }
                };
                child.stdout?.on('data', handleData);
                child.stderr?.on('data', handleData);

                const entry: RunningTask = { task, runId: run.id, child, startedAt: Date.now(), shutdown: false };
                this.runningTasks.set(task.id, entry);

                child.on('close', async (code) => {
                    this.runningTasks.delete(task.id);
                    if (task.batchId) this.activeBatchIds.delete(task.batchId);

                    if (entry.shutdown) return;

                    const currentRun = await TaskRunService.getById(run.id);
                    if (!currentRun || currentRun.status !== 'running') return;

                    if (code === 0) {
                        await TaskRunService.done(run.id);
                        await TaskService.done(task.id);
                        console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg: 'task done', taskId: task.id }));
                    } else {
                        const lastOutput = output.slice(-2000);
                        await TaskRunService.fail(run.id, lastOutput);
                        const currentStatus = await TaskService.getById(task.id);
                        if (currentStatus?.status === 'running') {
                            await TaskService.fail(task.id, 'Worker执行异常：Opencode 进程非正常退出');
                        }
                        console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', msg: 'task failed', taskId: task.id, code }));
                    }
                });

                child.on('error', async (err) => {
                    this.runningTasks.delete(task.id);
                    if (task.batchId) this.activeBatchIds.delete(task.batchId);

                    if (entry.shutdown) return;

                    const currentRun = await TaskRunService.getById(run.id);
                    if (!currentRun || currentRun.status !== 'running') return;

                    await TaskRunService.fail(run.id, err.message);
                    const currentStatus = await TaskService.getById(task.id);
                    if (currentStatus?.status === 'running') {
                        await TaskService.fail(task.id, `spawn 异常: ${err.message}`);
                    }
                    console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', msg: 'task spawn error', taskId: task.id, error: err.message }));
                });
            } catch (err) {
                console.error(JSON.stringify({
                    ts: new Date().toISOString(),
                    level: 'error',
                    msg: 'tryDispatch iteration failed',
                    error: err instanceof Error ? err.message : String(err),
                }));
                break;
            }
        }
    }

    private async updateHeartbeats() {
        for (const [, entry] of this.runningTasks) {
            try {
                await TaskRunService.heartbeat(entry.runId);
            } catch {
            }
        }
    }

    private killEntry(entry: RunningTask): Promise<void> {
        if (entry.child.exitCode !== null) {
            return Promise.resolve();
        }

        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                try {
                    if (entry.child.pid) process.kill(entry.child.pid, 'SIGKILL');
                } catch {}
                resolve();
            }, 5000);

            entry.child.on('close', () => {
                clearTimeout(timeout);
                resolve();
            });

            try {
                if (entry.child.pid) {
                    entry.child.kill('SIGTERM');
                } else {
                    clearTimeout(timeout);
                    resolve();
                }
            } catch {
                clearTimeout(timeout);
                resolve();
            }
        });
    }

    private resolveModel(taskModel: string | null): string | null {
        if (!taskModel || taskModel === 'default') return null;
        return taskModel;
    }
}
