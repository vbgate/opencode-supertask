import { db, schema } from '@core/db';
import { and, eq, desc, sql } from 'drizzle-orm';
import type { TaskTemplate, NewTaskTemplate, ScheduleType } from '@core/db/schema';
import { getNextCronRun, isValidCronExpr } from '@core/cron-parser';
import { validateTaskWorkingDirectory } from '@core/task-working-directory';
import { normalizeTaskBatchId } from '@core/task-batch';
import { normalizeModelVariant } from '@core/model-variant';

const { taskTemplates } = schema;

export type TaskTemplateUpdate = Pick<TaskTemplate,
    'name' | 'agent' | 'model' | 'prompt' | 'cwd' | 'category' | 'importance' | 'urgency'
    | 'batchId' | 'scheduleType' | 'cronExpr' | 'intervalMs' | 'runAt' | 'maxInstances'
    | 'maxRetries' | 'retryBackoffMs' | 'timeoutMs'
> & { variant?: string | null };

export class TaskTemplateService {
    static async create(data: NewTaskTemplate): Promise<TaskTemplate> {
        const normalizedData = {
            ...data,
            batchId: normalizeTaskBatchId(data.batchId),
            variant: normalizeModelVariant(data.variant),
        };
        this.validate(normalizedData);
        const now = Date.now();
        const nextRunAt = normalizedData.nextRunAt ?? this.calculateNextRunAt(
            normalizedData.scheduleType as ScheduleType,
            {
                cronExpr: normalizedData.cronExpr ?? null,
                intervalMs: normalizedData.intervalMs ?? null,
                runAt: normalizedData.runAt ?? null,
            },
            now,
        );
        const result = await db
            .insert(taskTemplates)
            .values({ ...normalizedData, nextRunAt, createdAt: now, updatedAt: now })
            .returning();
        return result[0];
    }

    private static validate(data: NewTaskTemplate): void {
        if (!data.name.trim()) throw new Error('name 不能为空');
        if (!data.agent.trim()) throw new Error('agent 不能为空');
        if (!data.prompt.trim()) throw new Error('prompt 不能为空');
        validateTaskWorkingDirectory(data.cwd);

        const scheduleType = data.scheduleType as ScheduleType;
        if (!['cron', 'delayed', 'recurring'].includes(scheduleType)) {
            throw new Error('scheduleType 必须是 cron、delayed 或 recurring');
        }
        if (scheduleType === 'cron' && (!data.cronExpr || !isValidCronExpr(data.cronExpr))) {
            throw new Error('cronExpr 缺失或格式无效');
        }
        if (scheduleType === 'recurring' && (!Number.isInteger(data.intervalMs) || (data.intervalMs ?? 0) <= 0)) {
            throw new Error('intervalMs 必须是正整数');
        }
        if (scheduleType === 'delayed' && (!Number.isInteger(data.runAt) || (data.runAt ?? 0) <= 0)) {
            throw new Error('runAt 必须是正整数时间戳');
        }

        this.validateInteger('importance', data.importance, 1, 5);
        this.validateInteger('urgency', data.urgency, 1, 5);
        this.validateInteger('maxInstances', data.maxInstances, 1, 1000);
        this.validateInteger('maxRetries', data.maxRetries, 0, 1000);
        this.validateInteger('retryBackoffMs', data.retryBackoffMs, 0, 86_400_000);
        this.validateInteger('timeoutMs', data.timeoutMs, 1000, 604_800_000);
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

    static async list(limit = 50, offset = 0): Promise<TaskTemplate[]> {
        return await db
            .select()
            .from(taskTemplates)
            .orderBy(desc(taskTemplates.createdAt), desc(taskTemplates.id))
            .limit(limit)
            .offset(offset);
    }

    static async stats(): Promise<{ total: number; enabled: number; disabled: number }> {
        const result = await db.select({
            total: sql<number>`count(*)`,
            enabled: sql<number>`sum(case when ${taskTemplates.enabled} = 1 then 1 else 0 end)`,
        }).from(taskTemplates);
        const total = Number(result[0]?.total ?? 0);
        const enabled = Number(result[0]?.enabled ?? 0);
        return { total, enabled, disabled: total - enabled };
    }

    static async getById(id: number): Promise<TaskTemplate | null> {
        const result = await db.select().from(taskTemplates).where(eq(taskTemplates.id, id));
        return result[0] || null;
    }

    static async update(id: number, data: TaskTemplateUpdate): Promise<TaskTemplate | null> {
        const normalizedData = {
            ...data,
            batchId: normalizeTaskBatchId(data.batchId) ?? null,
            ...(data.variant === undefined
                ? {}
                : { variant: normalizeModelVariant(data.variant) ?? null }),
        };
        this.validate(normalizedData);
        const now = Date.now();
        const nextRunAt = this.calculateNextRunAt(
            normalizedData.scheduleType as ScheduleType,
            normalizedData,
            now,
        );

        return db.transaction((tx) => {
            const existing = tx
                .select({ id: taskTemplates.id })
                .from(taskTemplates)
                .where(eq(taskTemplates.id, id))
                .limit(1)
                .get();
            if (!existing) return null;

            return tx
                .update(taskTemplates)
                .set({ ...normalizedData, nextRunAt, updatedAt: now })
                .where(eq(taskTemplates.id, id))
                .returning()
                .get() ?? null;
        }, { behavior: 'immediate' });
    }

    static async enable(id: number): Promise<TaskTemplate | null> {
        return db.transaction((tx) => {
            const template = tx
                .select()
                .from(taskTemplates)
                .where(eq(taskTemplates.id, id))
                .limit(1)
                .get();
            if (!template) return null;

            const nextRunAt = template.nextRunAt ?? this.calculateNextRunAt(
                template.scheduleType as ScheduleType,
                template,
            );
            if (nextRunAt == null) {
                throw new Error(`模板 #${id} 无法计算下一次执行时间，已保持禁用`);
            }

            return tx
                .update(taskTemplates)
                .set({ enabled: true, nextRunAt, updatedAt: Date.now() })
                .where(eq(taskTemplates.id, id))
                .returning()
                .get() ?? null;
        }, { behavior: 'immediate' });
    }

    static async disable(id: number): Promise<TaskTemplate | null> {
        const result = await db
            .update(taskTemplates)
            .set({ enabled: false, updatedAt: Date.now() })
            .where(eq(taskTemplates.id, id))
            .returning();
        return result[0] || null;
    }

    static async delete(id: number): Promise<boolean> {
        const result = await db.delete(taskTemplates).where(eq(taskTemplates.id, id)).returning();
        return result.length > 0;
    }

    static async deleteExpiredDelayed(
        retentionDays: number,
        shouldStop: () => boolean = () => false,
    ): Promise<number> {
        const cutoffMs = Date.now() - retentionDays * 86_400_000;
        const batchSize = 500;
        let deletedTotal = 0;

        while (!shouldStop()) {
            const deleted = db.transaction((tx) => tx
                .delete(taskTemplates)
                .where(and(
                    sql`${taskTemplates.id} IN (
                        SELECT candidate.id
                        FROM task_templates AS candidate
                        WHERE candidate.schedule_type = 'delayed'
                          AND candidate.enabled = 0
                          AND candidate.last_run_at IS NOT NULL
                          AND candidate.last_run_at < ${cutoffMs}
                          AND NOT EXISTS (
                              SELECT 1 FROM tasks AS active_task
                              WHERE active_task.template_id = candidate.id
                                AND (
                                    active_task.status IN ('pending', 'running')
                                    OR (
                                        active_task.status = 'failed'
                                        AND active_task.retry_count <= active_task.max_retries
                                    )
                                )
                          )
                          AND NOT EXISTS (
                              SELECT 1
                              FROM task_runs AS active_run
                              INNER JOIN tasks AS run_task ON run_task.id = active_run.task_id
                              WHERE run_task.template_id = candidate.id
                                AND active_run.status = 'running'
                          )
                        ORDER BY candidate.last_run_at, candidate.id
                        LIMIT ${batchSize}
                    )`,
                ))
                .returning({ id: taskTemplates.id })
                .all()
                .length, { behavior: 'immediate' });
            if (deleted === 0) break;
            deletedTotal += deleted;
            await Bun.sleep(0);
        }

        return deletedTotal;
    }

    static calculateNextRunAt(
        scheduleType: ScheduleType,
        template: {
            cronExpr: string | null;
            intervalMs: number | null;
            runAt: number | null;
        },
        afterMs?: number,
    ): number | null {
        const base = afterMs ?? Date.now();

        switch (scheduleType) {
            case 'cron': {
                if (!template.cronExpr || !isValidCronExpr(template.cronExpr)) return null;
                return getNextCronRun(template.cronExpr, base);
            }
            case 'recurring': {
                if (!template.intervalMs) return null;
                return base + template.intervalMs;
            }
            case 'delayed': {
                return template.runAt ?? null;
            }
            default:
                return null;
        }
    }
}
