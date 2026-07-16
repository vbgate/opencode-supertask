import { db, schema } from '@core/db';
import { eq, desc, and, inArray } from 'drizzle-orm';
import type { TaskRun, NewTaskRun } from '@core/db/schema';
import { isProcessAlive } from '@core/process-control';

const { taskRuns } = schema;

export interface StaleRunInfo {
    runId: number;
    taskId: number;
    childPid: number | null;
    workerPid: number | null;
    taskRetryCount: number;
    taskMaxRetries: number;
    taskRetryBackoffMs: number;
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

    static async updatePid(id: number, workerPid: number, childPid: number): Promise<TaskRun | null> {
        const result = await db
            .update(taskRuns)
            .set({
                workerPid,
                childPid,
                lockedAt: Date.now(),
                lockedBy: `gateway-${process.pid}`,
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
                startedAt: taskRuns.startedAt,
                heartbeatAt: taskRuns.heartbeatAt,
                taskRetryCount: tasksTable.retryCount,
                taskMaxRetries: tasksTable.maxRetries,
                taskRetryBackoffMs: tasksTable.retryBackoffMs,
            })
            .from(taskRuns)
            .innerJoin(tasksTable, eq(taskRuns.taskId, tasksTable.id))
            .where(eq(taskRuns.status, 'running'));
        return result.filter((row) => {
            const heartbeatExpired = row.heartbeatAt == null
                ? row.startedAt != null && row.startedAt.getTime() < cutoffMs
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
            taskRetryCount: row.taskRetryCount ?? 0,
            taskMaxRetries: row.taskMaxRetries ?? 3,
            taskRetryBackoffMs: row.taskRetryBackoffMs ?? 30000,
        }));
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
