import { db, schema } from '@core/db';
import { eq, and, sql } from 'drizzle-orm';
import { TaskService } from '@core/services/task.service';
import { TaskTemplateService } from '@core/services/task-template.service';
import { getNextCronRun, isValidCronExpr } from '@core/cron-parser';
import type { ScheduleType } from '@core/db/schema';

const { taskTemplates } = schema;

export async function cloneTaskFromTemplate(templateId: number) {
    const rows = await db
        .select()
        .from(taskTemplates)
        .where(eq(taskTemplates.id, templateId))
        .limit(1);
    const tmpl = rows[0];
    if (!tmpl || !tmpl.enabled) return null;

    const activeCount = await db
        .select({ count: sql<number>`count(*)` })
        .from(schema.tasks)
        .where(
            and(
                eq(schema.tasks.templateId, templateId),
                sql`${schema.tasks.status} IN ('pending', 'running')`,
            ),
        )
        .then((r) => r[0].count);

    if (activeCount >= (tmpl.maxInstances ?? 1)) return null;

    const nowMs = Date.now();
    const isDelayed = tmpl.scheduleType === 'delayed';
    const nextRunAt = isDelayed
        ? null
        : TaskTemplateService.calculateNextRunAt(
            tmpl.scheduleType as ScheduleType,
            tmpl,
            nowMs,
        );

    const task = await TaskService.add({
        name: tmpl.name,
        agent: tmpl.agent,
        model: tmpl.model ?? 'default',
        prompt: tmpl.prompt,
        cwd: tmpl.cwd ?? null,
        category: tmpl.category ?? 'general',
        importance: tmpl.importance ?? 3,
        urgency: tmpl.urgency ?? 3,
        maxRetries: tmpl.maxRetries ?? 3,
        templateId: tmpl.id,
        scheduledAt: nowMs,
    });

    await db
        .update(taskTemplates)
        .set({
            lastRunAt: nowMs,
            nextRunAt,
            enabled: isDelayed ? false : tmpl.enabled,
            updatedAt: nowMs,
        })
        .where(eq(taskTemplates.id, templateId));

    return task;
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
        );
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
