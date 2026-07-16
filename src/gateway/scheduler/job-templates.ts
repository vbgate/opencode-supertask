import { db, schema } from '@core/db';
import { eq, and, asc, sql, isNull } from 'drizzle-orm';
import { TaskTemplateService } from '@core/services/task-template.service';
import type { ScheduleType } from '@core/db/schema';

const { taskTemplates } = schema;
export const DUE_TEMPLATE_BATCH_SIZE = 100;

export interface DueTemplateCursor {
    nextRunAt: number;
    id: number;
}

export async function cloneTaskFromTemplate(templateId: number) {
    return createTaskFromTemplate(templateId, { advanceSchedule: true });
}

export async function triggerTaskFromTemplate(templateId: number) {
    return createTaskFromTemplate(templateId, {
        advanceSchedule: false,
        namePrefix: '[手动触发] ',
    });
}

function createTaskFromTemplate(
    templateId: number,
    options: { advanceSchedule: boolean; namePrefix?: string },
) {
    const nowMs = Date.now();
    return db.transaction((tx) => {
        const tmpl = tx
            .select()
            .from(taskTemplates)
            .where(eq(taskTemplates.id, templateId))
            .limit(1)
            .get();
        if (!tmpl || (options.advanceSchedule && !tmpl.enabled)) return null;

        const activeTasks = tx
            .select({ count: sql<number>`count(*)` })
            .from(schema.tasks)
            .where(and(
                eq(schema.tasks.templateId, templateId),
                sql`${schema.tasks.status} IN ('pending', 'running')`,
            ))
            .get();
        const retryableTasks = tx
            .select({ count: sql<number>`count(*)` })
            .from(schema.tasks)
            .where(and(
                eq(schema.tasks.templateId, templateId),
                eq(schema.tasks.status, 'failed'),
                sql`${schema.tasks.retryCount} <= ${schema.tasks.maxRetries}`,
            ))
            .get();
        const detachedRuns = tx
            .select({ count: sql<number>`count(DISTINCT ${schema.taskRuns.taskId})` })
            .from(schema.taskRuns)
            .innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskRuns.taskId))
            .where(and(
                eq(schema.taskRuns.status, 'running'),
                eq(schema.tasks.templateId, templateId),
                sql`NOT (
                    ${schema.tasks.status} IN ('pending', 'running')
                    OR (
                        ${schema.tasks.status} = 'failed'
                        AND ${schema.tasks.retryCount} <= ${schema.tasks.maxRetries}
                    )
                )`,
            ))
            .get();
        const activeCount = Number(activeTasks?.count ?? 0)
            + Number(retryableTasks?.count ?? 0)
            + Number(detachedRuns?.count ?? 0);
        if (activeCount >= (tmpl.maxInstances ?? 1)) {
            if (options.advanceSchedule && tmpl.scheduleType !== 'delayed') {
                const nextRunAt = TaskTemplateService.calculateNextRunAt(
                    tmpl.scheduleType as ScheduleType,
                    tmpl,
                    nowMs,
                );
                tx.update(taskTemplates)
                    .set({ nextRunAt, updatedAt: nowMs })
                    .where(and(eq(taskTemplates.id, templateId), eq(taskTemplates.enabled, true)))
                    .run();
            }
            return null;
        }

        const isDelayed = tmpl.scheduleType === 'delayed';
        const nextRunAt = isDelayed
            ? null
            : TaskTemplateService.calculateNextRunAt(
                tmpl.scheduleType as ScheduleType,
                tmpl,
                nowMs,
            );
        const task = tx
            .insert(schema.tasks)
            .values({
                name: `${options.namePrefix ?? ''}${tmpl.name}`,
                agent: tmpl.agent,
                model: tmpl.model ?? 'default',
                prompt: tmpl.prompt,
                cwd: tmpl.cwd ?? null,
                category: tmpl.category ?? 'general',
                importance: tmpl.importance ?? 3,
                urgency: tmpl.urgency ?? 3,
                batchId: tmpl.batchId,
                maxRetries: tmpl.maxRetries ?? 3,
                retryBackoffMs: tmpl.retryBackoffMs ?? 30000,
                timeoutMs: tmpl.timeoutMs,
                templateId: tmpl.id,
                scheduledAt: options.advanceSchedule ? (tmpl.nextRunAt ?? nowMs) : nowMs,
            })
            .returning()
            .get();

        if (options.advanceSchedule) {
            tx.update(taskTemplates)
                .set({
                    lastRunAt: nowMs,
                    nextRunAt,
                    enabled: isDelayed ? false : tmpl.enabled,
                    updatedAt: nowMs,
                })
                .where(and(eq(taskTemplates.id, templateId), eq(taskTemplates.enabled, true)))
                .run();
        }
        return task;
    }, { behavior: 'immediate' });
}

export async function getDueTemplates(
    cursor: DueTemplateCursor | null = null,
    cutoffNow = Date.now(),
) {
    return await db
        .select()
        .from(taskTemplates)
        .where(
            and(
                eq(taskTemplates.enabled, true),
                sql`${taskTemplates.nextRunAt} IS NOT NULL`,
                sql`${taskTemplates.nextRunAt} <= ${cutoffNow}`,
                cursor
                    ? sql`(
                        ${taskTemplates.nextRunAt} > ${cursor.nextRunAt}
                        OR (
                            ${taskTemplates.nextRunAt} = ${cursor.nextRunAt}
                            AND ${taskTemplates.id} > ${cursor.id}
                        )
                    )`
                    : undefined,
            ),
        )
        .orderBy(asc(taskTemplates.nextRunAt), asc(taskTemplates.id))
        .limit(DUE_TEMPLATE_BATCH_SIZE);
}

export async function initializeNextRunAt(templateId: number) {
    return db.transaction((tx) => {
        const tmpl = tx
            .select()
            .from(taskTemplates)
            .where(and(
                eq(taskTemplates.id, templateId),
                eq(taskTemplates.enabled, true),
                isNull(taskTemplates.nextRunAt),
            ))
            .limit(1)
            .get();
        if (!tmpl) return null;

        const nextRunAt = TaskTemplateService.calculateNextRunAt(
            tmpl.scheduleType as ScheduleType,
            tmpl,
        );
        if (nextRunAt == null) return null;

        return tx
            .update(taskTemplates)
            .set({ nextRunAt, updatedAt: Date.now() })
            .where(and(
                eq(taskTemplates.id, templateId),
                eq(taskTemplates.enabled, true),
                isNull(taskTemplates.nextRunAt),
            ))
            .returning()
            .get() ?? null;
    }, { behavior: 'immediate' });
}
