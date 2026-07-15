import { db, schema } from '@core/db';
import { eq, desc } from 'drizzle-orm';
import type { TaskTemplate, NewTaskTemplate, ScheduleType } from '@core/db/schema';
import { getNextCronRun, isValidCronExpr } from '@core/cron-parser';

const { taskTemplates } = schema;

export class TaskTemplateService {
    static async create(data: NewTaskTemplate): Promise<TaskTemplate> {
        this.validate(data);
        const now = Date.now();
        const result = await db.insert(taskTemplates).values({ ...data, createdAt: now, updatedAt: now }).returning();
        const tmpl = result[0];

        if (tmpl.nextRunAt == null) {
            const nextRunAt = this.calculateNextRunAt(
                tmpl.scheduleType as ScheduleType,
                tmpl,
            );
            if (nextRunAt != null) {
                await db.update(taskTemplates).set({ nextRunAt }).where(eq(taskTemplates.id, tmpl.id));
                tmpl.nextRunAt = nextRunAt;
            }
        }

        return tmpl;
    }

    private static validate(data: NewTaskTemplate): void {
        if (!data.name.trim()) throw new Error('name 不能为空');
        if (!data.agent.trim()) throw new Error('agent 不能为空');
        if (!data.prompt.trim()) throw new Error('prompt 不能为空');

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

    static async list(limit = 50): Promise<TaskTemplate[]> {
        return await db
            .select()
            .from(taskTemplates)
            .orderBy(desc(taskTemplates.createdAt))
            .limit(limit);
    }

    static async getById(id: number): Promise<TaskTemplate | null> {
        const result = await db.select().from(taskTemplates).where(eq(taskTemplates.id, id));
        return result[0] || null;
    }

    static async enable(id: number): Promise<TaskTemplate | null> {
        const result = await db
            .update(taskTemplates)
            .set({ enabled: true, updatedAt: Date.now() })
            .where(eq(taskTemplates.id, id))
            .returning();
        return result[0] || null;
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
