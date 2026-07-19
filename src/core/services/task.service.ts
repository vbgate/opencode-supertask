// 任务服务层
// 封装所有任务相关的 CRUD 操作

import { db, getSqlite, schema } from '@core/db';
import { eq, and, desc, asc, sql, isNull, or } from 'drizzle-orm';
import type { Task, NewTask, TaskStatus } from '@core/db/schema';
import { computeBackoff } from '@core/backoff';
import { validateTaskWorkingDirectory } from '@core/task-working-directory';
import {
    normalizeTaskBatchId,
    TASK_BATCH_TRIM_CHARACTERS,
} from '@core/task-batch';
import { normalizeModelVariant } from '@core/model-variant';

const { tasks, taskRuns } = schema;
let cleanupInvocation = 0;

export interface TaskProjectSummary {
    cwd: string;
    total: number;
    pending: number;
    running: number;
    failed: number;
    done: number;
    lastCreatedAt: number | null;
}

export interface EditableTaskUpdate {
    name?: string;
    agent?: string;
    model?: string;
    variant?: string | null;
    prompt?: string;
    category?: string;
    importance?: number;
    urgency?: number;
    batchId?: string | null;
    maxRetries?: number;
    retryBackoffMs?: number;
    timeoutMs?: number | null;
}

interface TaskQueueScope {
    cwd?: string;
    excludedBatchIds?: string[];
}

export class TaskDeletionConflictError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'TaskDeletionConflictError';
    }
}

function hasNoExecutableDependents() {
    return sql`NOT EXISTS (
        SELECT 1 FROM tasks AS dependent_task
        WHERE dependent_task.depends_on = ${tasks.id}
          AND dependent_task.status IN ('pending', 'running', 'failed', 'dead_letter')
    )`;
}

function hasViableDependency() {
    return or(
        isNull(tasks.dependsOn),
        sql`EXISTS (
            SELECT 1 FROM tasks AS dependency_task
            WHERE dependency_task.id = ${tasks.dependsOn}
              AND dependency_task.cwd IS ${tasks.cwd}
              AND (
                  dependency_task.status IN ('pending', 'running', 'done')
                  OR (
                      dependency_task.status = 'failed'
                      AND dependency_task.retry_count <= dependency_task.max_retries
                  )
              )
        )`,
    );
}

function blockedDependentsOf(prerequisiteId: number) {
    return sql`${tasks.id} IN (
        WITH RECURSIVE blocked_task(id) AS (
            SELECT direct_dependent.id
            FROM tasks AS direct_dependent
            WHERE direct_dependent.depends_on = ${prerequisiteId}
              AND direct_dependent.status IN ('pending', 'failed')
              AND EXISTS (
                  SELECT 1 FROM tasks AS prerequisite
                  WHERE prerequisite.id = ${prerequisiteId}
                    AND prerequisite.status IN ('dead_letter', 'cancelled')
              )
            UNION
            SELECT descendant.id
            FROM tasks AS descendant
            INNER JOIN blocked_task ON descendant.depends_on = blocked_task.id
            WHERE descendant.status IN ('pending', 'failed')
        )
        SELECT id FROM blocked_task
    )`;
}

export class TaskService {
    private static buildScopeWhere(scope?: { cwd?: string }) {
        const conditions: Array<ReturnType<typeof eq>> = [];
        if (scope?.cwd !== undefined) {
            conditions.push(eq(tasks.cwd, scope.cwd));
        }
        return conditions;
    }

    static async add(data: NewTask): Promise<Task> {
        const normalizedData = {
            ...data,
            batchId: normalizeTaskBatchId(data.batchId),
            variant: normalizeModelVariant(data.variant),
        };
        this.validateNewTask(normalizedData);
        return db.transaction((tx) => {
            if (normalizedData.dependsOn != null) {
                const dependency = tx
                    .select({
                        id: tasks.id,
                        cwd: tasks.cwd,
                        status: tasks.status,
                        retryCount: tasks.retryCount,
                        maxRetries: tasks.maxRetries,
                    })
                    .from(tasks)
                    .where(eq(tasks.id, normalizedData.dependsOn))
                    .get();
                if (!dependency) {
                    throw new Error(`dependsOn 指向的任务 #${normalizedData.dependsOn} 不存在`);
                }
                if ((dependency.cwd ?? null) !== (normalizedData.cwd ?? null)) {
                    throw new Error('dependsOn 必须指向同一 cwd 的任务');
                }
                const dependencyIsRecoverable = dependency.status === 'pending'
                    || dependency.status === 'running'
                    || dependency.status === 'done'
                    || (
                        dependency.status === 'failed'
                        && (dependency.retryCount ?? 0) <= (dependency.maxRetries ?? 3)
                    );
                if (!dependencyIsRecoverable) {
                    throw new Error(`dependsOn 指向的任务 #${normalizedData.dependsOn} 已进入不可恢复终态`);
                }
            }
            return tx.insert(tasks).values(normalizedData).returning().get();
        }, { behavior: 'immediate' });
    }

    static async update(
        id: number,
        data: EditableTaskUpdate,
        scope: { cwd?: string } = {},
    ): Promise<Task | null> {
        if (Object.keys(data).length === 0) throw new Error('至少提供一个要修改的字段');
        const normalizedData: EditableTaskUpdate = {
            ...data,
            ...(data.batchId === undefined
                ? {}
                : { batchId: normalizeTaskBatchId(data.batchId) ?? null }),
            ...(data.variant === undefined
                ? {}
                : { variant: normalizeModelVariant(data.variant) ?? null }),
        };
        return db.transaction((tx) => {
            const task = tx.select().from(tasks).where(and(
                eq(tasks.id, id),
                sql`${tasks.status} IN ('pending', 'failed', 'dead_letter')`,
                ...this.buildScopeWhere(scope),
            )).get();
            if (!task) return null;

            this.validateNewTask({
                name: normalizedData.name ?? task.name,
                agent: normalizedData.agent ?? task.agent,
                model: normalizedData.model ?? task.model,
                variant: normalizedData.variant === undefined ? task.variant : normalizedData.variant,
                prompt: normalizedData.prompt ?? task.prompt,
                cwd: task.cwd,
                category: normalizedData.category ?? task.category,
                importance: normalizedData.importance ?? task.importance,
                urgency: normalizedData.urgency ?? task.urgency,
                batchId: normalizedData.batchId === undefined ? task.batchId : normalizedData.batchId,
                maxRetries: normalizedData.maxRetries ?? task.maxRetries,
                retryBackoffMs: normalizedData.retryBackoffMs ?? task.retryBackoffMs,
                timeoutMs: normalizedData.timeoutMs === undefined ? task.timeoutMs : normalizedData.timeoutMs,
                dependsOn: task.dependsOn,
            });
            const maxRetries = normalizedData.maxRetries ?? task.maxRetries ?? 3;
            const exhausted = task.status === 'failed' && (task.retryCount ?? 0) > maxRetries;
            const updated = tx.update(tasks).set({
                ...normalizedData,
                ...(exhausted ? {
                    status: 'dead_letter',
                    retryAfter: null,
                } : {}),
            }).where(eq(tasks.id, id)).returning().get() ?? null;
            if (exhausted && updated) {
                const finishedAt = new Date();
                tx.update(tasks)
                    .set({
                        status: 'dead_letter',
                        finishedAt,
                        retryAfter: null,
                        resultLog: `依赖任务 #${id} 已进入不可恢复终态`,
                    })
                    .where(blockedDependentsOf(id))
                    .run();
            }
            return updated;
        }, { behavior: 'immediate' });
    }

    private static validateNewTask(data: NewTask): void {
        if (!data.name.trim()) throw new Error('name 不能为空');
        if (!data.agent.trim()) throw new Error('agent 不能为空');
        if (!data.prompt.trim()) throw new Error('prompt 不能为空');
        validateTaskWorkingDirectory(data.cwd);
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

    private static buildRunnableTaskWhere(scope: TaskQueueScope) {
        const baseConditions = [...this.buildScopeWhere(scope)];
        const nowMs = Date.now();
        const retryAfterFilter = or(
            isNull(tasks.retryAfter),
            sql`${tasks.retryAfter} <= ${nowMs}`,
        );

        const excludedBatchIds = [...new Set((scope.excludedBatchIds ?? [])
            .map((batchId) => normalizeTaskBatchId(batchId))
            .filter((batchId): batchId is string => Boolean(batchId)))];
        const hasExcludedBatches = excludedBatchIds.length > 0;
        let batchFilter: ReturnType<typeof sql> | undefined;
        if (hasExcludedBatches) {
            batchFilter = or(
                isNull(tasks.batchId),
                sql`trim(${tasks.batchId}, ${TASK_BATCH_TRIM_CHARACTERS}) = ''`,
                sql`trim(${tasks.batchId}, ${TASK_BATCH_TRIM_CHARACTERS}) NOT IN ${excludedBatchIds}`,
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

        return and(
            ...conditions,
            or(
                isNull(tasks.dependsOn),
                sql`EXISTS (
                    SELECT 1 FROM tasks AS dependency_task
                    WHERE dependency_task.id = ${tasks.dependsOn}
                      AND dependency_task.status = 'done'
                      AND dependency_task.cwd IS ${tasks.cwd}
                )`,
            ),
            or(
                isNull(tasks.batchId),
                sql`trim(${tasks.batchId}, ${TASK_BATCH_TRIM_CHARACTERS}) = ''`,
                sql`NOT EXISTS (
                    SELECT 1 FROM tasks AS running_batch_task
                    WHERE trim(running_batch_task.batch_id, ${TASK_BATCH_TRIM_CHARACTERS})
                        = trim(${tasks.batchId}, ${TASK_BATCH_TRIM_CHARACTERS})
                      AND (
                          running_batch_task.status = 'running'
                          OR EXISTS (
                              SELECT 1 FROM task_runs AS running_batch_run
                              WHERE running_batch_run.task_id = running_batch_task.id
                                AND running_batch_run.status = 'running'
                          )
                      )
                    )`,
            ),
            sql`NOT EXISTS (
                SELECT 1 FROM task_runs AS candidate_active_run
                WHERE candidate_active_run.task_id = ${tasks.id}
                  AND candidate_active_run.status = 'running'
            )`,
        );
    }

    static async next(scope: TaskQueueScope = {}): Promise<Task | null> {

        const result = await db
            .select()
            .from(tasks)
            .where(this.buildRunnableTaskWhere(scope))
            .orderBy(
                desc(tasks.urgency),
                desc(tasks.importance),
                asc(tasks.createdAt),
                asc(tasks.id),
            )
            .limit(1);

        return result[0] ?? null;
    }

    static async claimNext(scope: TaskQueueScope = {}): Promise<Task | null> {
        return db.transaction((tx) => {
            const candidate = tx
                .select()
                .from(tasks)
                .where(this.buildRunnableTaskWhere(scope))
                .orderBy(
                    desc(tasks.urgency),
                    desc(tasks.importance),
                    asc(tasks.createdAt),
                    asc(tasks.id),
                )
                .limit(1)
                .get();
            if (!candidate) return null;

            return tx
                .update(tasks)
                .set({
                    status: 'running',
                    startedAt: new Date(),
                    finishedAt: null,
                })
                .where(eq(tasks.id, candidate.id))
                .returning()
                .get() ?? null;
        }, { behavior: 'immediate' });
    }

    static async countRunning(
        scope: { cwd?: string; legacyCwd?: boolean; batchId?: string } = {},
    ): Promise<number> {
        const scopeConditions = scope.legacyCwd
            ? [sql`${tasks.cwd} IS NULL OR trim(${tasks.cwd}) = ''`]
            : this.buildScopeWhere(scope);
        if (scope.batchId !== undefined) {
            const batchId = normalizeTaskBatchId(scope.batchId);
            scopeConditions.push(batchId
                ? sql`trim(${tasks.batchId}, ${TASK_BATCH_TRIM_CHARACTERS}) = ${batchId}`
                : sql`0`);
        }
        return db.transaction((tx) => {
            const runningTasks = tx
                .select({ count: sql<number>`count(*)` })
                .from(tasks)
                .where(and(eq(tasks.status, 'running'), ...scopeConditions))
                .get();
            const runsWithoutRunningTask = tx
                .select({ count: sql<number>`count(DISTINCT ${taskRuns.taskId})` })
                .from(taskRuns)
                .innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
                .where(and(
                    eq(taskRuns.status, 'running'),
                    sql`${tasks.status} <> 'running'`,
                    ...scopeConditions,
                ))
                .get();
            return Number(runningTasks?.count ?? 0) + Number(runsWithoutRunningTask?.count ?? 0);
        }, { behavior: 'deferred' });
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
        return db.transaction((tx) => {
            const current = tx
                .select()
                .from(tasks)
                .where(and(
                    eq(tasks.id, id),
                    eq(tasks.status, 'running'),
                    ...this.buildScopeWhere(scope),
                ))
                .get();
            if (!current) return null;

            const newRetryCount = (current.retryCount ?? 0) + 1;
            const maxRetries = current.maxRetries ?? 3;
            const isDeadLetter = options?.setDeadLetter ?? newRetryCount > maxRetries;
            const failed = tx
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
                .where(and(eq(tasks.id, id), eq(tasks.status, 'running')))
                .returning()
                .get();
            if (failed?.status === 'dead_letter') {
                tx.update(tasks)
                    .set({
                        status: 'dead_letter',
                        finishedAt: new Date(),
                        retryAfter: null,
                        resultLog: `依赖任务 #${id} 已进入不可恢复终态`,
                    })
                    .where(blockedDependentsOf(id))
                    .run();
            }
            return failed ?? null;
        }, { behavior: 'immediate' });
    }

    static async completeRun(taskId: number, runId: number, log?: string): Promise<Task | null> {
        return db.transaction((tx) => {
            const currentTask = tx
                .select()
                .from(tasks)
                .where(and(eq(tasks.id, taskId), eq(tasks.status, 'running')))
                .get();
            const currentRun = tx
                .select({ id: taskRuns.id })
                .from(taskRuns)
                .where(and(
                    eq(taskRuns.id, runId),
                    eq(taskRuns.taskId, taskId),
                    eq(taskRuns.status, 'running'),
                ))
                .get();
            if (!currentTask || !currentRun) return null;

            const finishedAt = new Date();
            const completed = tx
                .update(tasks)
                .set({
                    status: 'done',
                    finishedAt,
                    resultLog: log,
                    retryAfter: null,
                })
                .where(and(eq(tasks.id, taskId), eq(tasks.status, 'running')))
                .returning()
                .get();
            if (!completed) return null;

            tx.update(taskRuns)
                .set({ status: 'done', finishedAt, log })
                .where(and(eq(taskRuns.id, runId), eq(taskRuns.status, 'running')))
                .run();
            return completed;
        }, { behavior: 'immediate' });
    }

    static async failRun(
        taskId: number,
        runId: number,
        log?: string,
        options?: { setDeadLetter?: boolean; retryAfterMs?: number },
    ): Promise<Task | null> {
        const failed = db.transaction((tx) => {
            const currentTask = tx
                .select()
                .from(tasks)
                .where(and(eq(tasks.id, taskId), eq(tasks.status, 'running')))
                .get();
            const currentRun = tx
                .select({ id: taskRuns.id })
                .from(taskRuns)
                .where(and(
                    eq(taskRuns.id, runId),
                    eq(taskRuns.taskId, taskId),
                    eq(taskRuns.status, 'running'),
                ))
                .get();
            if (!currentTask || !currentRun) return null;

            const newRetryCount = (currentTask.retryCount ?? 0) + 1;
            const maxRetries = currentTask.maxRetries ?? 3;
            const isDeadLetter = options?.setDeadLetter ?? newRetryCount > maxRetries;
            const finishedAt = new Date();
            const retryAfter = isDeadLetter
                ? null
                : (options?.retryAfterMs ?? Date.now() + computeBackoff(
                    newRetryCount,
                    currentTask.retryBackoffMs ?? 30000,
                ));

            const failed = tx
                .update(tasks)
                .set({
                    status: isDeadLetter ? 'dead_letter' : 'failed',
                    finishedAt,
                    resultLog: log,
                    retryCount: newRetryCount,
                    retryAfter,
                })
                .where(and(eq(tasks.id, taskId), eq(tasks.status, 'running')))
                .returning()
                .get();
            if (!failed) return null;

            tx.update(taskRuns)
                .set({ status: 'failed', finishedAt, log })
                .where(and(eq(taskRuns.id, runId), eq(taskRuns.status, 'running')))
                .run();
            if (failed.status === 'dead_letter') {
                tx.update(tasks)
                    .set({
                        status: 'dead_letter',
                        finishedAt,
                        retryAfter: null,
                        resultLog: `依赖任务 #${taskId} 已进入不可恢复终态`,
                    })
                    .where(blockedDependentsOf(taskId))
                    .run();
            }
            return failed;
        }, { behavior: 'immediate' });
        return failed;
    }

    static async recoverRun(
        taskId: number,
        runId: number,
        log: string,
    ): Promise<{ status: 'pending' | 'dead_letter'; retryCount: number; retryAfterMs: number | null } | null> {
        const recovery = db.transaction((tx) => {
            const currentTask = tx
                .select()
                .from(tasks)
                .where(and(eq(tasks.id, taskId), eq(tasks.status, 'running')))
                .get();
            const currentRun = tx
                .select({ id: taskRuns.id })
                .from(taskRuns)
                .where(and(
                    eq(taskRuns.id, runId),
                    eq(taskRuns.taskId, taskId),
                    eq(taskRuns.status, 'running'),
                ))
                .get();
            if (!currentRun) return null;

            const finishedAt = new Date();
            tx.update(taskRuns)
                .set({ status: 'failed', finishedAt, log })
                .where(and(eq(taskRuns.id, runId), eq(taskRuns.status, 'running')))
                .run();

            if (!currentTask) return null;
            const retryCount = (currentTask.retryCount ?? 0) + 1;
            const maxRetries = currentTask.maxRetries ?? 3;
            const isDeadLetter = retryCount > maxRetries;
            const recoveryStatus: 'pending' | 'dead_letter' = isDeadLetter ? 'dead_letter' : 'pending';
            const retryAfterMs = isDeadLetter
                ? null
                : Date.now() + computeBackoff(
                    retryCount,
                    currentTask.retryBackoffMs ?? 30000,
                );

            tx.update(tasks)
                .set({
                    status: recoveryStatus,
                    startedAt: null,
                    finishedAt: isDeadLetter ? finishedAt : null,
                    retryCount,
                    retryAfter: retryAfterMs,
                    resultLog: log,
                })
                .where(and(eq(tasks.id, taskId), eq(tasks.status, 'running')))
                .run();
            if (recoveryStatus === 'dead_letter') {
                tx.update(tasks)
                    .set({
                        status: 'dead_letter',
                        finishedAt,
                        retryAfter: null,
                        resultLog: `依赖任务 #${taskId} 已进入不可恢复终态`,
                    })
                    .where(blockedDependentsOf(taskId))
                    .run();
            }
            return {
                status: recoveryStatus,
                retryCount,
                retryAfterMs,
            };
        }, { behavior: 'immediate' });
        return recovery;
    }

    static async interruptRun(
        taskId: number,
        runId: number,
        log: string,
    ): Promise<boolean> {
        return db.transaction((tx) => {
            const currentRun = tx
                .select({ id: taskRuns.id })
                .from(taskRuns)
                .where(and(
                    eq(taskRuns.id, runId),
                    eq(taskRuns.taskId, taskId),
                    eq(taskRuns.status, 'running'),
                ))
                .get();
            if (!currentRun) return false;

            const updatedRun = tx.update(taskRuns)
                .set({ status: 'failed', finishedAt: new Date(), log })
                .where(and(eq(taskRuns.id, runId), eq(taskRuns.status, 'running')))
                .returning({ id: taskRuns.id })
                .get();
            tx.update(tasks)
                .set({
                    status: 'pending',
                    startedAt: null,
                    finishedAt: null,
                    retryAfter: null,
                    resultLog: log,
                })
                .where(and(eq(tasks.id, taskId), eq(tasks.status, 'running')))
                .run();
            return updatedRun != null;
        }, { behavior: 'immediate' });
    }

    static async resolveBlockedDependencies(): Promise<number> {
        const finishedAt = new Date();
        const result = await db
            .update(tasks)
            .set({
                status: 'dead_letter',
                finishedAt,
                retryAfter: null,
                resultLog: '依赖任务不存在、跨项目或已进入不可恢复终态',
            })
            .where(sql`${tasks.id} IN (
                WITH RECURSIVE blocked_task(id) AS (
                    SELECT candidate.id
                    FROM tasks AS candidate
                    WHERE candidate.status IN ('pending', 'failed')
                      AND candidate.depends_on IS NOT NULL
                      AND NOT EXISTS (
                          SELECT 1 FROM tasks AS viable_dependency
                          WHERE viable_dependency.id = candidate.depends_on
                            AND viable_dependency.cwd IS candidate.cwd
                            AND (
                                viable_dependency.status IN ('pending', 'running', 'done')
                                OR (
                                    viable_dependency.status = 'failed'
                                    AND viable_dependency.retry_count <= viable_dependency.max_retries
                                )
                            )
                      )
                    UNION
                    SELECT descendant.id
                    FROM tasks AS descendant
                    INNER JOIN blocked_task ON descendant.depends_on = blocked_task.id
                    WHERE descendant.status IN ('pending', 'failed')
                )
                SELECT id FROM blocked_task
            )`)
            .returning();
        return result.length;
    }

    static async rejectBlockedDependents(prerequisiteId: number): Promise<number> {
        const result = await db
            .update(tasks)
            .set({
                status: 'dead_letter',
                finishedAt: new Date(),
                retryAfter: null,
                resultLog: `依赖任务 #${prerequisiteId} 已进入不可恢复终态`,
            })
            .where(blockedDependentsOf(prerequisiteId))
            .returning({ id: tasks.id });
        return result.length;
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
        return db.transaction((tx) => {
            const finishedAt = new Date();
            const task = tx
                .update(tasks)
                .set({ status: 'dead_letter', finishedAt, retryCount })
                .where(eq(tasks.id, id))
                .returning()
                .get();
            if (!task) return null;
            tx.update(tasks)
                .set({
                    status: 'dead_letter',
                    finishedAt,
                    retryAfter: null,
                    resultLog: `依赖任务 #${id} 已进入不可恢复终态`,
                })
                .where(blockedDependentsOf(id))
                .run();
            return task;
        }, { behavior: 'immediate' });
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
        return db.transaction((tx) => {
            const finishedAt = new Date();
            const task = tx
                .update(tasks)
                .set({
                    status: 'cancelled',
                    finishedAt,
                    retryAfter: null,
                })
                .where(and(...conditions))
                .returning()
                .get();
            if (!task) return null;
            tx.update(tasks)
                .set({
                    status: 'dead_letter',
                    finishedAt,
                    retryAfter: null,
                    resultLog: `依赖任务 #${id} 已进入不可恢复终态`,
                })
                .where(blockedDependentsOf(id))
                .run();
            return task;
        }, { behavior: 'immediate' });
    }

    static async retry(id: number, scope: { cwd?: string } = {}): Promise<Task | null> {
        const conditions = [
            eq(tasks.id, id),
            or(eq(tasks.status, 'failed'), eq(tasks.status, 'dead_letter')),
            ...this.buildScopeWhere(scope),
        ];
        return db.transaction((tx) => tx
            .update(tasks)
            .set({
                status: 'pending',
                startedAt: null,
                finishedAt: null,
                retryAfter: null,
                retryCount: 0,
            })
            .where(and(...conditions, hasViableDependency()))
            .returning()
            .get() ?? null, { behavior: 'immediate' });
    }

    static async retryBatch(batchId: string, scope: { cwd?: string } = {}): Promise<number> {
        const normalizedBatchId = normalizeTaskBatchId(batchId);
        if (!normalizedBatchId) return 0;
        const sqlite = getSqlite();
        const scopeFilter = scope.cwd === undefined ? '' : 'AND candidate.cwd = ?';
        const parameters = scope.cwd === undefined
            ? [TASK_BATCH_TRIM_CHARACTERS, normalizedBatchId]
            : [TASK_BATCH_TRIM_CHARACTERS, normalizedBatchId, scope.cwd];

        return db.transaction(() => sqlite.query(`
            WITH RECURSIVE
            candidate(id, cwd, depends_on) AS MATERIALIZED (
                SELECT candidate.id, candidate.cwd, candidate.depends_on
                FROM tasks AS candidate
                WHERE trim(candidate.batch_id, ?) = ?
                  AND candidate.status IN ('failed', 'dead_letter')
                  ${scopeFilter}
            ),
            retryable(id, cwd, depends_on) AS (
                SELECT candidate.id,
                       candidate.cwd,
                       candidate.depends_on
                FROM candidate
                WHERE candidate.depends_on IS NULL
                   OR (
                       NOT EXISTS (
                           SELECT 1 FROM candidate AS internal_parent
                           WHERE internal_parent.id = candidate.depends_on
                       )
                       AND EXISTS (
                           SELECT 1 FROM tasks AS external_parent
                           WHERE external_parent.id = candidate.depends_on
                             AND external_parent.cwd IS candidate.cwd
                             AND (
                                 external_parent.status IN ('pending', 'running', 'done')
                                 OR (
                                     external_parent.status = 'failed'
                                     AND external_parent.retry_count <= external_parent.max_retries
                                 )
                             )
                       )
                   )
                UNION
                SELECT child.id,
                       child.cwd,
                       child.depends_on
                FROM candidate AS child
                INNER JOIN retryable AS parent
                    ON child.depends_on = parent.id
                   AND child.cwd IS parent.cwd
            )
            UPDATE tasks
            SET status = 'pending',
                started_at = NULL,
                finished_at = NULL,
                retry_after = NULL,
                retry_count = 0
            WHERE id IN (SELECT id FROM retryable)
        `).run(...parameters).changes, { behavior: 'immediate' });
    }

    static async getById(id: number, scope: { cwd?: string } = {}): Promise<Task | null> {
        const conditions = [eq(tasks.id, id), ...this.buildScopeWhere(scope)];
        const result = await db.select().from(tasks).where(and(...conditions));
        return result[0] || null;
    }

    static async list(options: {
        status?: TaskStatus;
        activeExecution?: boolean;
        batchId?: string;
        category?: string;
        cwd?: string;
        legacyCwd?: boolean;
        limit?: number;
        offset?: number;
    } = {}): Promise<Task[]> {
        let query = db.select().from(tasks).$dynamic();

        const conditions = [];
        if (options.activeExecution) {
            conditions.push(or(
                eq(tasks.status, 'running'),
                sql`EXISTS (
                    SELECT 1 FROM task_runs AS active_list_run
                    WHERE active_list_run.task_id = ${tasks.id}
                      AND active_list_run.status = 'running'
                )`,
            ));
        } else if (options.status) {
            conditions.push(eq(tasks.status, options.status));
        }
        if (options.batchId !== undefined) {
            const batchId = normalizeTaskBatchId(options.batchId);
            conditions.push(batchId
                ? sql`trim(${tasks.batchId}, ${TASK_BATCH_TRIM_CHARACTERS}) = ${batchId}`
                : sql`0`);
        }
        if (options.category) {
            conditions.push(eq(tasks.category, options.category));
        }
        if (options.legacyCwd) {
            conditions.push(sql`${tasks.cwd} IS NULL OR trim(${tasks.cwd}) = ''`);
        } else if (options.cwd !== undefined) {
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

    static async stats(options: {
        batchId?: string;
        cwd?: string;
        legacyCwd?: boolean;
    } = {}): Promise<Record<string, number>> {
        const conditions = [];
        if (options.batchId !== undefined) {
            const batchId = normalizeTaskBatchId(options.batchId);
            conditions.push(batchId
                ? sql`trim(${tasks.batchId}, ${TASK_BATCH_TRIM_CHARACTERS}) = ${batchId}`
                : sql`0`);
        }
        if (options.legacyCwd) {
            conditions.push(sql`${tasks.cwd} IS NULL OR trim(${tasks.cwd}) = ''`);
        } else if (options.cwd !== undefined) {
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

    static async projectSummaries(limit = 100): Promise<TaskProjectSummary[]> {
        this.validateInteger('limit', limit, 1, 1000);
        const lastCreatedAt = sql<number | null>`max(${tasks.createdAt})`;
        const lastTaskId = sql<number>`max(${tasks.id})`;
        const rows = await db
            .select({
                cwd: tasks.cwd,
                total: sql<number>`count(*)`,
                pending: sql<number>`sum(CASE WHEN ${tasks.status} = 'pending' THEN 1 ELSE 0 END)`,
                running: sql<number>`sum(CASE WHEN ${tasks.status} = 'running' OR EXISTS (
                    SELECT 1 FROM task_runs AS active_project_run
                    WHERE active_project_run.task_id = ${tasks.id}
                      AND active_project_run.status = 'running'
                ) THEN 1 ELSE 0 END)`,
                failed: sql<number>`sum(CASE WHEN ${tasks.status} IN ('failed', 'dead_letter') THEN 1 ELSE 0 END)`,
                done: sql<number>`sum(CASE WHEN ${tasks.status} = 'done' THEN 1 ELSE 0 END)`,
                lastCreatedAt,
            })
            .from(tasks)
            .where(sql`${tasks.cwd} IS NOT NULL AND trim(${tasks.cwd}) <> ''`)
            .groupBy(tasks.cwd)
            .orderBy(desc(lastCreatedAt), desc(lastTaskId))
            .limit(limit);

        return rows.flatMap((row) => row.cwd === null ? [] : [{
            cwd: row.cwd,
            total: Number(row.total),
            pending: Number(row.pending),
            running: Number(row.running),
            failed: Number(row.failed),
            done: Number(row.done),
            lastCreatedAt: row.lastCreatedAt === null ? null : Number(row.lastCreatedAt) * 1000,
        }]);
    }

    static async delete(id: number, scope: { cwd?: string } = {}): Promise<boolean> {
        const conditions = [
            eq(tasks.id, id),
            sql`${tasks.status} <> 'running'`,
            sql`NOT EXISTS (
                SELECT 1 FROM ${taskRuns}
                WHERE ${taskRuns.taskId} = ${tasks.id}
                  AND ${taskRuns.status} = 'running'
            )`,
            hasNoExecutableDependents(),
            ...this.buildScopeWhere(scope),
        ];
        const result = await db.delete(tasks).where(and(...conditions)).returning();
        if (result.length > 0) {
            // 正式 Schema 使用 ON DELETE CASCADE；测试库未启用外键，仍需显式收敛关联记录。
            await db.delete(taskRuns).where(eq(taskRuns.taskId, id));
            return true;
        }

        if (!await this.getById(id, scope)) return false;

        const dependent = await db
            .select({ id: tasks.id })
            .from(tasks)
            .where(and(
                eq(tasks.dependsOn, id),
                sql`${tasks.status} IN ('pending', 'running', 'failed', 'dead_letter')`,
            ))
            .orderBy(asc(tasks.id))
            .limit(1);
        if (dependent[0]) {
            throw new TaskDeletionConflictError(
                `任务 #${id} 仍被可执行任务 #${dependent[0].id} 依赖，请先处理依赖任务`,
            );
        }
        throw new TaskDeletionConflictError(
            `任务 #${id} 正在运行，请先取消任务并等待执行进程退出`,
        );
    }

    static async deleteOlderThan(
        retentionDays: number,
        shouldStop: () => boolean = () => false,
    ): Promise<number> {
        const cutoffSec = Math.floor(Date.now() / 1000) - retentionDays * 86400;
        const batchSize = 500;
        const sqlite = getSqlite();
        cleanupInvocation += 1;
        const candidateTable = `cleanup_candidates_${process.pid}_${cleanupInvocation}`;
        let deletedTotal = 0;

        sqlite.exec(`
            CREATE TEMP TABLE ${candidateTable} (
                id INTEGER NOT NULL PRIMARY KEY
            ) WITHOUT ROWID;
        `);
        try {
            let ceilingId: number | null = null;
            while (true) {
                if (shouldStop()) return deletedTotal;
                const batch = db.transaction(() => {
                    sqlite.query(`DELETE FROM ${candidateTable}`).run();
                    const ceilingPredicate = ceilingId == null
                        ? ''
                        : 'AND candidate.id < ?';
                    const rawCandidateStatement = sqlite.query(`
                        INSERT INTO ${candidateTable}(id)
                        SELECT candidate.id
                        FROM tasks AS candidate NOT INDEXED
                        WHERE candidate.status IN ('done', 'dead_letter', 'cancelled')
                          AND candidate.finished_at IS NOT NULL
                          AND candidate.finished_at < ?
                          ${ceilingPredicate}
                          AND NOT EXISTS (
                              SELECT 1 FROM task_runs AS active_run
                              WHERE active_run.task_id = candidate.id
                                AND active_run.status = 'running'
                          )
                        ORDER BY candidate.id DESC
                        LIMIT ?
                    `);
                    const rawCount = ceilingId == null
                        ? rawCandidateStatement.run(cutoffSec, batchSize).changes
                        : rawCandidateStatement.run(cutoffSec, ceilingId, batchSize).changes;
                    if (rawCount === 0) return { deleted: 0, nextCeilingId: null };
                    const rawPage = sqlite.query(`
                        SELECT min(id) AS nextCeilingId FROM ${candidateTable}
                    `).get() as { nextCeilingId: number };

                    // 正常依赖边总是 child.id > parent.id。反向边或自环说明数据异常，
                    // 先保留该节点，再通过下面的叶到根剪枝保留整个受影响祖先链。
                    sqlite.query(`
                        DELETE FROM ${candidateTable}
                        WHERE EXISTS (
                            SELECT 1 FROM tasks AS anomalous
                            WHERE anomalous.id = ${candidateTable}.id
                              AND anomalous.depends_on IS NOT NULL
                              AND anomalous.depends_on >= anomalous.id
                        )
                    `).run();

                    while (true) {
                        const pruned = sqlite.query(`
                            DELETE FROM ${candidateTable}
                            WHERE EXISTS (
                                SELECT 1 FROM tasks AS dependent_task
                                WHERE dependent_task.depends_on = ${candidateTable}.id
                                  AND NOT EXISTS (
                                      SELECT 1 FROM ${candidateTable} AS selected_dependent
                                      WHERE selected_dependent.id = dependent_task.id
                                  )
                            )
                        `).run().changes;
                        if (pruned === 0) break;
                    }

                    const selected = sqlite.query(`
                        SELECT count(*) AS count FROM ${candidateTable}
                    `).get() as { count: number };
                    if (selected.count === 0) {
                        return { deleted: 0, nextCeilingId: rawPage.nextCeilingId };
                    }

                    sqlite.query(`
                        DELETE FROM tasks
                        WHERE id IN (SELECT id FROM ${candidateTable})
                    `).run();
                    const remaining = sqlite.query(`
                        SELECT count(*) AS count
                        FROM tasks
                        WHERE id IN (SELECT id FROM ${candidateTable})
                    `).get() as { count: number };
                    if (remaining.count !== 0) {
                        throw new Error('历史清理候选在同一写事务内发生漂移，已回滚本批删除');
                    }
                    return { deleted: selected.count, nextCeilingId: rawPage.nextCeilingId };
                }, { behavior: 'immediate' });
                if (batch.nextCeilingId == null) break;
                ceilingId = batch.nextCeilingId;
                deletedTotal += batch.deleted;

                await Bun.sleep(0);
                if (shouldStop()) return deletedTotal;
            }
            return deletedTotal;
        } finally {
            sqlite.exec(`DROP TABLE IF EXISTS ${candidateTable}`);
        }
    }
}
