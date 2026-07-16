import { db, schema } from '@core/db';
import { eq, desc, and, inArray } from 'drizzle-orm';
import type { TaskRun, NewTaskRun } from '@core/db/schema';
import { isProcessAlive } from '@core/process-control';

const { tasks, taskRuns } = schema;

export interface StaleRunInfo {
    runId: number;
    taskId: number;
    childPid: number | null;
    workerPid: number | null;
    launchProtocol: string | null;
    lockedBy: string | null;
    taskRetryCount: number;
    taskMaxRetries: number;
    taskRetryBackoffMs: number;
    taskStatus: string | null;
    taskCwd: string | null;
    ownerAlive: boolean;
}

export interface LegacyQuarantinedRun {
    runId: number;
    taskId: number;
    taskStatus: string | null;
    taskCwd: string | null;
    workerPid: number | null;
    ownerAlive: boolean;
}

export interface AbandonedLegacyRun {
    runId: number;
    taskId: number;
    runStatus: 'failed';
    taskStatus: 'cancelled';
}

export class LegacyRunAbandonConflictError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'LegacyRunAbandonConflictError';
    }
}

export class TaskRunService {
    static async create(data: NewTaskRun): Promise<TaskRun> {
        const result = await db.insert(taskRuns).values(data).returning();
        return result[0];
    }

    static async updateSessionId(id: number, sessionId: string): Promise<TaskRun | null> {
        const result = await db
            .update(taskRuns)
            .set({ sessionId })
            .where(and(eq(taskRuns.id, id), eq(taskRuns.status, 'running')))
            .returning();
        return result[0] || null;
    }

    static async done(id: number, log?: string): Promise<TaskRun | null> {
        const result = await db
            .update(taskRuns)
            .set({
                status: 'done',
                finishedAt: new Date(),
                log,
            })
            .where(and(eq(taskRuns.id, id), eq(taskRuns.status, 'running')))
            .returning();
        return result[0] || null;
    }

    static async fail(id: number, log?: string): Promise<TaskRun | null> {
        const result = await db
            .update(taskRuns)
            .set({
                status: 'failed',
                finishedAt: new Date(),
                log,
            })
            .where(and(eq(taskRuns.id, id), eq(taskRuns.status, 'running')))
            .returning();
        return result[0] || null;
    }

    static async heartbeat(id: number): Promise<TaskRun | null> {
        const result = await db
            .update(taskRuns)
            .set({ heartbeatAt: Date.now() })
            .where(and(eq(taskRuns.id, id), eq(taskRuns.status, 'running')))
            .returning();
        return result[0] || null;
    }

    static async updatePid(
        id: number,
        workerPid: number,
        childPid: number,
        lockedBy = `gateway-${process.pid}`,
    ): Promise<TaskRun | null> {
        const result = await db
            .update(taskRuns)
            .set({
                workerPid,
                childPid,
                lockedAt: Date.now(),
                lockedBy,
            })
            .where(and(eq(taskRuns.id, id), eq(taskRuns.status, 'running')))
            .returning();
        return result[0] || null;
    }

    static async getById(id: number): Promise<TaskRun | null> {
        const result = await db.select().from(taskRuns).where(eq(taskRuns.id, id));
        return result[0] || null;
    }

    static async listByTaskId(taskId: number): Promise<TaskRun[]> {
        return await db
            .select()
            .from(taskRuns)
            .where(eq(taskRuns.taskId, taskId))
            .orderBy(desc(taskRuns.startedAt), desc(taskRuns.id));
    }

    static async getLatestByTaskId(taskId: number): Promise<TaskRun | null> {
        const result = await db
            .select()
            .from(taskRuns)
            .where(eq(taskRuns.taskId, taskId))
            .orderBy(desc(taskRuns.startedAt), desc(taskRuns.id))
            .limit(1);
        return result[0] || null;
    }

    static async getLatestByTaskIds(taskIds: number[]): Promise<Map<number, TaskRun>> {
        if (taskIds.length === 0) return new Map();

        const latestRuns = await db
            .select()
            .from(taskRuns)
            .where(inArray(taskRuns.taskId, taskIds))
            .orderBy(desc(taskRuns.startedAt), desc(taskRuns.id));

        const result = new Map<number, TaskRun>();
        for (const run of latestRuns) {
            if (!result.has(run.taskId)) {
                result.set(run.taskId, run);
            }
        }
        return result;
    }

    static async getStaleRuns(heartbeatTimeoutMs: number): Promise<StaleRunInfo[]> {
        const cutoffMs = Date.now() - heartbeatTimeoutMs;
        const { tasks: tasksTable } = schema;
        const result = await db
            .select({
                runId: taskRuns.id,
                taskId: taskRuns.taskId,
                childPid: taskRuns.childPid,
                workerPid: taskRuns.workerPid,
                launchProtocol: taskRuns.launchProtocol,
                lockedBy: taskRuns.lockedBy,
                startedAt: taskRuns.startedAt,
                heartbeatAt: taskRuns.heartbeatAt,
                taskRetryCount: tasksTable.retryCount,
                taskMaxRetries: tasksTable.maxRetries,
                taskRetryBackoffMs: tasksTable.retryBackoffMs,
                taskStatus: tasksTable.status,
                taskCwd: tasksTable.cwd,
            })
            .from(taskRuns)
            .innerJoin(tasksTable, eq(taskRuns.taskId, tasksTable.id))
            .where(eq(taskRuns.status, 'running'));
        return result.filter((row) => {
            const heartbeatExpired = row.heartbeatAt == null
                ? row.startedAt == null || row.startedAt.getTime() < cutoffMs
                : row.heartbeatAt < cutoffMs;
            const ownerExited = row.workerPid != null
                && row.workerPid > 0
                && !isProcessAlive(row.workerPid);
            return heartbeatExpired || ownerExited;
        }).map((row) => ({
            runId: row.runId,
            taskId: row.taskId,
            childPid: row.childPid,
            workerPid: row.workerPid,
            launchProtocol: row.launchProtocol,
            lockedBy: row.lockedBy,
            taskRetryCount: row.taskRetryCount ?? 0,
            taskMaxRetries: row.taskMaxRetries ?? 3,
            taskRetryBackoffMs: row.taskRetryBackoffMs ?? 30000,
            taskStatus: row.taskStatus,
            taskCwd: row.taskCwd,
            ownerAlive: row.workerPid != null
                && row.workerPid > 0
                && isProcessAlive(row.workerPid),
        }));
    }

    static async listLegacyQuarantinedRuns(
        heartbeatTimeoutMs = 0,
    ): Promise<LegacyQuarantinedRun[]> {
        const staleRuns = await this.getStaleRuns(heartbeatTimeoutMs);
        return staleRuns
            .filter((row) => row.launchProtocol == null
                && row.childPid == null
            )
            .map((row) => ({
                runId: row.runId,
                taskId: row.taskId,
                taskStatus: row.taskStatus,
                taskCwd: row.taskCwd,
                workerPid: row.workerPid,
                ownerAlive: row.ownerAlive,
            }));
    }

    static async abandonLegacyRun(runId: number): Promise<AbandonedLegacyRun | null> {
        return db.transaction((tx) => {
            const current = tx
                .select({
                    runId: taskRuns.id,
                    taskId: taskRuns.taskId,
                    runStatus: taskRuns.status,
                    taskStatus: tasks.status,
                    workerPid: taskRuns.workerPid,
                    childPid: taskRuns.childPid,
                    launchProtocol: taskRuns.launchProtocol,
                    log: taskRuns.log,
                })
                .from(taskRuns)
                .innerJoin(tasks, eq(taskRuns.taskId, tasks.id))
                .where(eq(taskRuns.id, runId))
                .get();
            if (!current) return null;
            if (current.runStatus !== 'running') {
                throw new LegacyRunAbandonConflictError(`run #${runId} 已不是 running 状态`);
            }
            if (current.launchProtocol != null) {
                throw new LegacyRunAbandonConflictError(
                    `run #${runId} 使用未知或受管协议 ${current.launchProtocol}，禁止人工 abandon`,
                );
            }
            if (current.childPid != null) {
                throw new LegacyRunAbandonConflictError(
                    `run #${runId} 已记录 child PID ${current.childPid}，必须由 Worker/Watchdog 确认进程树退出`,
                );
            }
            if (current.workerPid != null && isProcessAlive(current.workerPid)) {
                throw new LegacyRunAbandonConflictError(
                    `run #${runId} 的 owner PID ${current.workerPid} 仍存活`,
                );
            }
            if (current.taskStatus !== 'cancelled') {
                throw new LegacyRunAbandonConflictError(
                    `任务 #${current.taskId} 必须先取消并保持 cancelled 状态`,
                );
            }

            const note = '操作员已确认旧版无 PID 执行不存在，并通过 run abandon 关闭隔离记录';
            const updated = tx
                .update(taskRuns)
                .set({
                    status: 'failed',
                    finishedAt: new Date(),
                    log: current.log ? `${current.log}\n${note}` : note,
                })
                .where(and(eq(taskRuns.id, runId), eq(taskRuns.status, 'running')))
                .returning({ id: taskRuns.id })
                .get();
            if (!updated) {
                throw new LegacyRunAbandonConflictError(`run #${runId} 状态已被其他操作改变`);
            }
            return {
                runId,
                taskId: current.taskId,
                runStatus: 'failed',
                taskStatus: 'cancelled',
            };
        }, { behavior: 'immediate' });
    }

    static async getRunningRunByTaskId(taskId: number): Promise<TaskRun | null> {
        const result = await db
            .select()
            .from(taskRuns)
            .where(and(eq(taskRuns.taskId, taskId), eq(taskRuns.status, 'running')))
            .orderBy(desc(taskRuns.startedAt), desc(taskRuns.id))
            .limit(1);
        return result[0] || null;
    }

    static async deleteByTaskIds(taskIds: number[]): Promise<number> {
        if (taskIds.length === 0) return 0;
        const result = await db
            .delete(taskRuns)
            .where(inArray(taskRuns.taskId, taskIds))
            .returning();
        return result.length;
    }

    static async getAllRunningRuns(): Promise<TaskRun[]> {
        return await db
            .select()
            .from(taskRuns)
            .where(eq(taskRuns.status, 'running'));
    }
}
