// 任务执行记录服务层
// 封装 task_runs 表的 CRUD 操作

import { db, schema } from '@core/db';
import { eq, desc, and, inArray, sql } from 'drizzle-orm';
import type { TaskRun, NewTaskRun, TaskRunStatus } from '@core/db/schema';

const { taskRuns } = schema;

export class TaskRunService {
    /**
     * 创建执行记录（任务开始时调用）
     */
    static async create(data: NewTaskRun): Promise<TaskRun> {
        const result = await db.insert(taskRuns).values(data).returning();
        return result[0];
    }

    /**
     * 更新 sessionId（从 opencode 输出解析后调用）
     */
    static async updateSessionId(id: number, sessionId: string): Promise<TaskRun | null> {
        const result = await db
            .update(taskRuns)
            .set({ sessionId })
            .where(eq(taskRuns.id, id))
            .returning();
        return result[0] || null;
    }

    /**
     * 标记执行完成
     */
    static async done(id: number, log?: string): Promise<TaskRun | null> {
        const result = await db
            .update(taskRuns)
            .set({
                status: 'done',
                finishedAt: new Date(),
                log,
            })
            .where(eq(taskRuns.id, id))
            .returning();
        return result[0] || null;
    }

    /**
     * 标记执行失败
     */
    static async fail(id: number, log?: string): Promise<TaskRun | null> {
        const result = await db
            .update(taskRuns)
            .set({
                status: 'failed',
                finishedAt: new Date(),
                log,
            })
            .where(eq(taskRuns.id, id))
            .returning();
        return result[0] || null;
    }

    /**
     * 获取单个执行记录
     */
    static async getById(id: number): Promise<TaskRun | null> {
        const result = await db.select().from(taskRuns).where(eq(taskRuns.id, id));
        return result[0] || null;
    }

    /**
     * 获取任务的所有执行记录（按时间倒序）
     */
    static async listByTaskId(taskId: number): Promise<TaskRun[]> {
        return await db
            .select()
            .from(taskRuns)
            .where(eq(taskRuns.taskId, taskId))
            .orderBy(desc(taskRuns.startedAt));
    }

    /**
     * 获取任务的最后一次执行记录
     */
    static async getLatestByTaskId(taskId: number): Promise<TaskRun | null> {
        const result = await db
            .select()
            .from(taskRuns)
            .where(eq(taskRuns.taskId, taskId))
            .orderBy(desc(taskRuns.startedAt))
            .limit(1);
        return result[0] || null;
    }

    /**
     * 批量获取多个任务的最后一次执行记录
     * 返回 Map<taskId, TaskRun>
     */
    static async getLatestByTaskIds(taskIds: number[]): Promise<Map<number, TaskRun>> {
        if (taskIds.length === 0) return new Map();

        // 使用子查询获取每个任务的最新执行记录
        const latestRuns = await db
            .select()
            .from(taskRuns)
            .where(inArray(taskRuns.taskId, taskIds))
            .orderBy(desc(taskRuns.startedAt));

        // 按 taskId 分组，只保留第一条（最新的）
        const result = new Map<number, TaskRun>();
        for (const run of latestRuns) {
            if (!result.has(run.taskId)) {
                result.set(run.taskId, run);
            }
        }
        return result;
    }
}
