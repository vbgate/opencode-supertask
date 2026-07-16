import { db, schema } from '@core/db';
import { eq, and, asc, sql } from 'drizzle-orm';
import { TaskTemplateService } from '@core/services/task-template.service';
import type { ScheduleType } from '@core/db/schema';

const { taskTemplates } = schema;

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

        const active = tx
            .select({ count: sql<number>`count(*)` })
            .from(schema.tasks)
            .where(and(
                eq(schema.tasks.templateId, templateId),
                sql`(
                    ${schema.tasks.status} IN ('pending', 'running')
                    OR (
                        ${schema.tasks.status} = 'failed'
                        AND ${schema.tasks.retryCount} <= ${schema.tasks.maxRetries}
                    )
                    OR EXISTS (
                        SELECT 1 FROM task_runs AS active_template_run
                        WHERE active_template_run.task_id = ${schema.tasks.id}
                          AND active_template_run.status = 'running'
                    )
                )`,
            ))
            .get();
        if (Number(active?.count ?? 0) >= (tmpl.maxInstances ?? 1)) return null;

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

export async function getDueTemplates() {
    const nowMs = Date.now();

    return await db
        .select()
        .from(taskTemplates)
        .where(
            and(
                eq(taskTemplates.enabled, true),
                sql`${taskTemplates.nextRunAt} IS NOT NULL`,
                sql`${taskTemplates.nextRunAt} <= ${nowMs}`,
            ),
        )
        .orderBy(asc(taskTemplates.nextRunAt), asc(taskTemplates.id));
}

export async function initializeNextRunAt(templateId: number) {
    const rows = await db
        .select()
        .from(taskTemplates)
        .where(eq(taskTemplates.id, templateId))
        .limit(1);
    const tmpl = rows[0];
    if (!tmpl || tmpl.nextRunAt != null) return;

    const nextRunAt = TaskTemplateService.calculateNextRunAt(
        tmpl.scheduleType as ScheduleType,
        tmpl,
    );

    if (nextRunAt != null) {
        await db
            .update(taskTemplates)
            .set({ nextRunAt })
            .where(eq(taskTemplates.id, templateId));
    }
}
