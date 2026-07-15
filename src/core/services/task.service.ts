// 任务服务层
// 封装所有任务相关的 CRUD 操作

import { db, schema } from '@core/db';
import { eq, and, desc, asc, sql, isNull, or } from 'drizzle-orm';
import type { Task, NewTask, TaskStatus } from '@core/db/schema';
import { computeBackoff } from '@core/backoff';

const { tasks, taskRuns } = schema;

export class TaskService {
    private static buildScopeWhere(scope?: { cwd?: string }) {
        const conditions: Array<ReturnType<typeof eq>> = [];
        if (scope?.cwd !== undefined) {
            conditions.push(eq(tasks.cwd, scope.cwd));
        }
        return conditions;
    }

    static async add(data: NewTask): Promise<Task> {
        this.validateNewTask(data);
        const result = await db.insert(tasks).values(data).returning();
        return result[0];
    }

    private static validateNewTask(data: NewTask): void {
        if (!data.name.trim()) throw new Error('name 不能为空');
        if (!data.agent.trim()) throw new Error('agent 不能为空');
        if (!data.prompt.trim()) throw new Error('prompt 不能为空');
        this.validateInteger('importance', data.importance, 1, 5);
        this.validateInteger('urgency', data.urgency, 1, 5);
        this.validateInteger('maxRetries', data.maxRetries, 0, 1000);
        this.validateInteger('retryBackoffMs', data.retryBackoffMs, 0, 86_400_000);
        this.validateInteger('timeoutMs', data.timeoutMs, 1000, 604_800_000);
        this.validateInteger('dependsOn', data.dependsOn, 1, Number.MAX_SAFE_INTEGER);
    }

    private static validateInteger(
        name: string,
        value: number | null | undefined,
        min: number,
        max: number,
    ): void {
        if (value === undefined || value === null) return;
        if (!Number.isInteger(value) || value < min || value > max) {
            throw new Error(`${name} 必须是 ${min} 到 ${max} 之间的整数`);
        }
    }

    static async next(
        scope: { cwd?: string; excludedBatchIds?: string[] } = {},
    ): Promise<Task | null> {
        const baseConditions = [...this.buildScopeWhere(scope)];
        const nowMs = Date.now();
        const retryAfterFilter = or(
            isNull(tasks.retryAfter),
            sql`${tasks.retryAfter} <= ${nowMs}`,
        );

        const hasExcludedBatches = scope.excludedBatchIds && scope.excludedBatchIds.length > 0;
        let batchFilter: ReturnType<typeof sql> | undefined;
        if (hasExcludedBatches) {
            batchFilter = or(
                isNull(tasks.batchId),
                sql`${tasks.batchId} NOT IN ${scope.excludedBatchIds!}`,
            );
        }

        const statusConditions = or(
            and(
                eq(tasks.status, 'pending'),
                retryAfterFilter,
            ),
            and(
                eq(tasks.status, 'failed'),
                sql`${tasks.retryCount} <= ${tasks.maxRetries}`,
                retryAfterFilter,
            ),
        );

        const conditions = [
            statusConditions,
            ...baseConditions,
        ];
        if (batchFilter) {
            conditions.push(batchFilter);
        }

        const allTasks = await db
            .select()
            .from(tasks)
            .where(and(...conditions))
            .orderBy(
                desc(tasks.urgency),
                desc(tasks.importance),
                asc(tasks.createdAt),
                asc(tasks.id),
            );

        for (const task of allTasks) {
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

    static async start(id: number, scope: { cwd?: string } = {}): Promise<Task | null> {
        const conditions = [
            eq(tasks.id, id),
            or(
                eq(tasks.status, 'pending'),
                and(
                eq(tasks.status, 'failed'),
                    sql`${tasks.retryCount} <= ${tasks.maxRetries}`,
                ),
            ),
            ...this.buildScopeWhere(scope),
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

    static async done(
        id: number,
        log?: string,
        scope: { cwd?: string } = {},
    ): Promise<Task | null> {
        const conditions = [
            eq(tasks.id, id),
            eq(tasks.status, 'running'),
            ...this.buildScopeWhere(scope),
        ];
        const result = await db
            .update(tasks)
            .set({
                status: 'done',
                finishedAt: new Date(),
                resultLog: log,
                retryAfter: null,
            })
            .where(and(...conditions))
            .returning();
        return result[0] || null;
    }

    static async fail(
        id: number,
        log?: string,
        scope: { cwd?: string } = {},
        options?: { setDeadLetter?: boolean; retryAfterMs?: number },
    ): Promise<Task | null> {
        const current = await this.getById(id, scope);
        if (!current || current.status !== 'running') return null;

        const newRetryCount = (current.retryCount ?? 0) + 1;
        const maxRetries = current.maxRetries ?? 3;
        const isDeadLetter = options?.setDeadLetter ?? newRetryCount > maxRetries;

        const conditions = [
            eq(tasks.id, id),
            eq(tasks.status, 'running'),
            ...this.buildScopeWhere(scope),
        ];
        const result = await db
            .update(tasks)
            .set({
                status: isDeadLetter ? 'dead_letter' : 'failed',
                finishedAt: new Date(),
                resultLog: log,
                retryCount: newRetryCount,
                retryAfter: isDeadLetter
                    ? null
                    : (options?.retryAfterMs ?? Date.now() + computeBackoff(
                        newRetryCount,
                        current.retryBackoffMs ?? 30000,
                    )),
            })
            .where(and(...conditions))
            .returning();
        return result[0] || null;
    }

    static async markPendingForRetry(
        id: number,
        retryAfterMs: number,
        retryCount: number,
    ): Promise<Task | null> {
        const result = await db
            .update(tasks)
            .set({
                status: 'pending',
                startedAt: null,
                finishedAt: null,
                retryAfter: retryAfterMs,
                retryCount,
            })
            .where(eq(tasks.id, id))
            .returning();
        return result[0] || null;
    }

    static async markDeadLetter(id: number, retryCount: number): Promise<Task | null> {
        const result = await db
            .update(tasks)
            .set({ status: 'dead_letter', finishedAt: new Date(), retryCount })
            .where(eq(tasks.id, id))
            .returning();
        return result[0] || null;
    }

    static async resetRunningToPending(ids: number[]): Promise<number> {
        if (ids.length === 0) return 0;
        const result = await db
            .update(tasks)
            .set({
                status: 'pending',
                startedAt: null,
                finishedAt: null,
            })
            .where(
                and(
                    sql`${tasks.id} IN ${ids}`,
                    eq(tasks.status, 'running'),
                ),
            )
            .returning();
        return result.length;
    }

    static async resetOrphanRunningToPending(): Promise<number> {
        const result = await db
            .update(tasks)
            .set({
                status: 'pending',
                startedAt: null,
                finishedAt: null,
            })
            .where(
                and(
                    eq(tasks.status, 'running'),
                    sql`NOT EXISTS (
                        SELECT 1 FROM ${taskRuns}
                        WHERE ${taskRuns.taskId} = ${tasks.id}
                          AND ${taskRuns.status} = 'running'
                    )`,
                ),
            )
            .returning();
        return result.length;
    }

    static async cancel(id: number, scope: { cwd?: string } = {}): Promise<Task | null> {
        const conditions = [
            eq(tasks.id, id),
            or(
                eq(tasks.status, 'pending'),
                eq(tasks.status, 'running'),
                eq(tasks.status, 'failed'),
            ),
            ...this.buildScopeWhere(scope),
        ];
        const result = await db
            .update(tasks)
            .set({
                status: 'cancelled',
                finishedAt: new Date(),
                retryAfter: null,
            })
            .where(and(...conditions))
            .returning();
        return result[0] || null;
    }

    static async retry(id: number, scope: { cwd?: string } = {}): Promise<Task | null> {
        const current = await this.getById(id, scope);
        if (!current) return null;
        if (current.status !== 'failed' && current.status !== 'dead_letter') return null;

        const conditions = [eq(tasks.id, id), ...this.buildScopeWhere(scope)];
        const result = await db
            .update(tasks)
            .set({
                status: 'pending',
                startedAt: null,
                finishedAt: null,
                retryAfter: null,
                retryCount: 0,
            })
            .where(and(...conditions))
            .returning();
        return result[0] || null;
    }

    static async retryBatch(batchId: string, scope: { cwd?: string } = {}): Promise<number> {
        const conditions = [
            eq(tasks.batchId, batchId),
            or(eq(tasks.status, 'failed'), eq(tasks.status, 'dead_letter')),
            ...this.buildScopeWhere(scope),
        ];
        const result = await db
            .update(tasks)
            .set({
                status: 'pending',
                startedAt: null,
                finishedAt: null,
                retryAfter: null,
                retryCount: 0,
            })
            .where(and(...conditions))
            .returning();
        return result.length;
    }

    static async getById(id: number, scope: { cwd?: string } = {}): Promise<Task | null> {
        const conditions = [eq(tasks.id, id), ...this.buildScopeWhere(scope)];
        const result = await db.select().from(tasks).where(and(...conditions));
        return result[0] || null;
    }

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

        query = query.orderBy(desc(tasks.createdAt), desc(tasks.id));

        if (options.limit) {
            query = query.limit(options.limit);
        }
        if (options.offset) {
            query = query.offset(options.offset);
        }

        return await query;
    }

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
            dead_letter: 0,
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

    static async delete(id: number, scope: { cwd?: string } = {}): Promise<boolean> {
        const conditions = [eq(tasks.id, id), ...this.buildScopeWhere(scope)];
        const existing = await db
            .select({ id: tasks.id })
            .from(tasks)
            .where(and(...conditions))
            .limit(1);
        if (!existing[0]) return false;

        await db.delete(taskRuns).where(eq(taskRuns.taskId, id));
        const result = await db.delete(tasks).where(and(...conditions)).returning();
        return result.length > 0;
    }

    static async deleteOlderThan(retentionDays: number): Promise<number> {
        const cutoffSec = Math.floor(Date.now() / 1000) - retentionDays * 86400;
        const result = await db
            .delete(tasks)
            .where(
                and(
                    sql`${tasks.status} IN ('done', 'failed', 'dead_letter')`,
                    sql`${tasks.finishedAt} IS NOT NULL`,
                    sql`${tasks.finishedAt} < ${cutoffSec}`,
                ),
            )
            .returning();
        return result.length;
    }
}
