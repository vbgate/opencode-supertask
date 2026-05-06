// 任务服务层
// 封装所有任务相关的 CRUD 操作

import { db, schema, closeDb } from '@core/db';
import { eq, and, desc, asc, sql, lt, isNull, or } from 'drizzle-orm';
import type { Task, NewTask, TaskStatus } from '@core/db/schema';

const { tasks } = schema;

export class TaskService {
    /**
     * 任务作用域
     * - cwd: 以提交任务时记录的 cwd 作为“项目”隔离键
     */
    private static buildScopeWhere(scope?: { cwd?: string }) {
        const conditions: Array<ReturnType<typeof eq>> = [];
        if (scope?.cwd !== undefined) {
            conditions.push(eq(tasks.cwd, scope.cwd));
        }
        return conditions;
    }

    /**
     * 创建新任务
     */
    static async add(data: NewTask): Promise<Task> {
        const result = await db.insert(tasks).values(data).returning();
        return result[0];
    }

    /**
     * 获取下一个待执行的任务
     * 优先级顺序：failed（可重试）→ pending
     * 按 createdAt 升序（先进先出 FIFO）
     * 会检查依赖任务是否已完成
     */
    static async next(scope: { cwd?: string } = {}): Promise<Task | null> {
        const baseConditions = [...this.buildScopeWhere(scope)];

        // 1. 先查可重试的 failed 任务
        const failedConditions = [
            eq(tasks.status, 'failed'),
            sql`${tasks.retryCount} < ${tasks.maxRetries}`,
            ...baseConditions
        ];
        const failedTasks = await db
            .select()
            .from(tasks)
            .where(and(...failedConditions))
            .orderBy(asc(tasks.createdAt));

        for (const task of failedTasks) {
            if (task.dependsOn) {
                const depTask = await this.getById(task.dependsOn, scope);
                if (depTask && depTask.status === 'done') {
                    return task;
                }
                continue;
            }
            return task;
        }

        // 2. 再查 pending 任务
        const pendingConditions = [
            eq(tasks.status, 'pending'),
            ...baseConditions
        ];
        const pendingTasks = await db
            .select()
            .from(tasks)
            .where(and(...pendingConditions))
            .orderBy(asc(tasks.createdAt));

        for (const task of pendingTasks) {
            if (task.dependsOn) {
                const depTask = await this.getById(task.dependsOn, scope);
                if (depTask && depTask.status === 'done') {
                    return task;
                }
                continue;
            }
            return task;
        }

        return null;
    }

    /**
     * 开始执行任务 - 标记为 running
     * 乐观锁：只更新 pending 或可重试的 failed 任务
     */
    static async start(id: number, scope: { cwd?: string } = {}): Promise<Task | null> {
        const conditions = [
            eq(tasks.id, id),
            or(
                eq(tasks.status, 'pending'),
                and(
                    eq(tasks.status, 'failed'),
                    sql`${tasks.retryCount} < ${tasks.maxRetries}`
                )
            ),
            ...this.buildScopeWhere(scope)
        ];
        const result = await db
            .update(tasks)
            .set({
                status: 'running',
                startedAt: new Date(),
                finishedAt: null,
            })
            .where(and(...conditions))
            .returning();
        return result[0] || null;
    }

    /**
     * 完成任务 - 标记为 done
     */
    static async done(
        id: number,
        log?: string,
        scope: { cwd?: string } = {}
    ): Promise<Task | null> {
        const conditions = [eq(tasks.id, id), ...this.buildScopeWhere(scope)];
        const result = await db
            .update(tasks)
            .set({
                status: 'done',
                finishedAt: new Date(),
                resultLog: log,
            })
            .where(and(...conditions))
            .returning();
        return result[0] || null;
    }

    /**
     * 任务失败 - 标记为 failed
     */
    static async fail(
        id: number,
        log?: string,
        scope: { cwd?: string } = {}
    ): Promise<Task | null> {
        // 先获取当前重试次数
        const current = await this.getById(id, scope);
        if (!current) return null;

        const conditions = [eq(tasks.id, id), ...this.buildScopeWhere(scope)];
        const result = await db
            .update(tasks)
            .set({
                status: 'failed',
                finishedAt: new Date(),
                resultLog: log,
                retryCount: (current.retryCount ?? 0) + 1,
            })
            .where(and(...conditions))
            .returning();
        return result[0] || null;
    }

    /**
     * 取消任务
     */
    static async cancel(id: number, scope: { cwd?: string } = {}): Promise<Task | null> {
        const conditions = [eq(tasks.id, id), ...this.buildScopeWhere(scope)];
        const result = await db
            .update(tasks)
            .set({ status: 'cancelled' })
            .where(and(...conditions))
            .returning();
        return result[0] || null;
    }

    /**
     * 重试任务 - 将 failed 重置为 pending
     */
    static async retry(id: number, scope: { cwd?: string } = {}): Promise<Task | null> {
        const current = await this.getById(id, scope);
        if (!current) return null;
        if (current.status !== 'failed') return null;

        const conditions = [eq(tasks.id, id), ...this.buildScopeWhere(scope)];
        const result = await db
            .update(tasks)
            .set({
                status: 'pending',
                startedAt: null,
                finishedAt: null,
            })
            .where(and(...conditions))
            .returning();
        return result[0] || null;
    }

    /**
     * 批量重试 - 按批次 ID
     */
    static async retryBatch(batchId: string, scope: { cwd?: string } = {}): Promise<number> {
        const conditions = [
            eq(tasks.batchId, batchId),
            eq(tasks.status, 'failed'),
            ...this.buildScopeWhere(scope),
        ];
        const result = await db
            .update(tasks)
            .set({
                status: 'pending',
                startedAt: null,
                finishedAt: null,
            })
            .where(and(...conditions))
            .returning();
        return result.length;
    }

    /**
     * 获取单个任务
     */
    static async getById(id: number, scope: { cwd?: string } = {}): Promise<Task | null> {
        const conditions = [eq(tasks.id, id), ...this.buildScopeWhere(scope)];
        const result = await db.select().from(tasks).where(and(...conditions));
        return result[0] || null;
    }

    /**
     * 列出任务
     */
    static async list(options: {
        status?: TaskStatus;
        batchId?: string;
        category?: string;
        cwd?: string;
        limit?: number;
        offset?: number;
    } = {}): Promise<Task[]> {
        let query = db.select().from(tasks).$dynamic();

        const conditions = [];
        if (options.status) {
            conditions.push(eq(tasks.status, options.status));
        }
        if (options.batchId) {
            conditions.push(eq(tasks.batchId, options.batchId));
        }
        if (options.category) {
            conditions.push(eq(tasks.category, options.category));
        }
        if (options.cwd !== undefined) {
            conditions.push(eq(tasks.cwd, options.cwd));
        }

        if (conditions.length > 0) {
            query = query.where(and(...conditions));
        }

        query = query.orderBy(desc(tasks.createdAt));

        if (options.limit) {
            query = query.limit(options.limit);
        }
        if (options.offset) {
            query = query.offset(options.offset);
        }

        return await query;
    }

    /**
     * 统计任务状态
     */
    static async stats(options: { batchId?: string; cwd?: string } = {}): Promise<Record<string, number>> {
        const conditions = [];
        if (options.batchId !== undefined) {
            conditions.push(eq(tasks.batchId, options.batchId));
        }
        if (options.cwd !== undefined) {
            conditions.push(eq(tasks.cwd, options.cwd));
        }
        const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

        const result = await db
            .select({
                status: tasks.status,
                count: sql<number>`count(*)`,
            })
            .from(tasks)
            .where(whereCondition)
            .groupBy(tasks.status);

        const stats: Record<string, number> = {
            total: 0,
            pending: 0,
            running: 0,
            done: 0,
            failed: 0,
            cancelled: 0,
        };

        for (const row of result) {
            if (row.status) {
                stats[row.status] = Number(row.count);
                stats.total += Number(row.count);
            }
        }

        return stats;
    }

    /**
     * 删除任务
     */
    static async delete(id: number, scope: { cwd?: string } = {}): Promise<boolean> {
        const conditions = [eq(tasks.id, id), ...this.buildScopeWhere(scope)];
        const result = await db.delete(tasks).where(and(...conditions)).returning();
        return result.length > 0;
    }
}
