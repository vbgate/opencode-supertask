import {
    DUE_TEMPLATE_BATCH_SIZE,
    getDueTemplates,
    cloneTaskFromTemplate,
    initializeNextRunAt,
    type DueTemplateCursor,
} from './job-templates';
import type { GatewayConfig } from '@gateway/config';
import { db, schema } from '@core/db';
import { and, asc, eq, gt, isNull } from 'drizzle-orm';
import {
    markGatewayActivity,
    markGatewayFailure,
    markGatewaySuccess,
} from '../health';

export class Scheduler {
    private stopped = false;
    private ticking = false;
    private timer: ReturnType<typeof setInterval> | null = null;
    private dueSweep: { cutoffNow: number; cursor: DueTemplateCursor | null } | null = null;

    constructor(private cfg: GatewayConfig) {}

    async start() {
        if (!this.cfg.scheduler.enabled) return;
        this.stopped = false;
        markGatewayActivity('scheduler');

        await this.initializeTemplates();
        markGatewaySuccess('scheduler');

        this.timer = setInterval(() => this.tick(), this.cfg.scheduler.checkIntervalMs);
    }

    stop() {
        this.stopped = true;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    private async tick() {
        if (this.stopped || this.ticking) return;
        markGatewayActivity('scheduler');
        this.ticking = true;
        let hadFailure = false;
        try {
            const sweep = this.dueSweep ?? { cutoffNow: Date.now(), cursor: null };
            const dueTemplates = await getDueTemplates(sweep.cursor, sweep.cutoffNow);
            const lastTemplate = dueTemplates.at(-1);
            for (const tmpl of dueTemplates) {
                try {
                    const task = await cloneTaskFromTemplate(tmpl.id, tmpl.nextRunAt!);
                    if (task) {
                        console.log(JSON.stringify({
                            ts: new Date().toISOString(),
                            level: 'info',
                            msg: 'scheduled task created',
                            templateId: tmpl.id,
                            taskId: task.id,
                        }));
                    }
                } catch (err) {
                    hadFailure = true;
                    markGatewayFailure('scheduler', err);
                    console.error(JSON.stringify({
                        ts: new Date().toISOString(),
                        level: 'error',
                        msg: 'failed to clone from template',
                        templateId: tmpl.id,
                        error: err instanceof Error ? err.message : String(err),
                    }));
                }
            }
            this.dueSweep = dueTemplates.length < DUE_TEMPLATE_BATCH_SIZE
                || lastTemplate?.nextRunAt == null
                ? null
                : {
                    cutoffNow: sweep.cutoffNow,
                    cursor: { nextRunAt: lastTemplate.nextRunAt, id: lastTemplate.id },
                };
            if (!hadFailure) markGatewaySuccess('scheduler');
        } catch (err) {
            markGatewayFailure('scheduler', err);
            console.error(JSON.stringify({
                ts: new Date().toISOString(),
                level: 'error',
                msg: 'scheduler tick failed',
                error: err instanceof Error ? err.message : String(err),
            }));
        } finally {
            this.ticking = false;
        }
    }

    private async initializeTemplates() {
        const { taskTemplates } = schema;
        const batchSize = 100;
        let cursor = 0;

        while (!this.stopped) {
            const templates = await db
                .select({ id: taskTemplates.id })
                .from(taskTemplates)
                .where(and(
                    eq(taskTemplates.enabled, true),
                    isNull(taskTemplates.nextRunAt),
                    gt(taskTemplates.id, cursor),
                ))
                .orderBy(asc(taskTemplates.id))
                .limit(batchSize);
            if (templates.length === 0) break;

            for (const tmpl of templates) {
                if (this.stopped) break;
                await initializeNextRunAt(tmpl.id);
            }
            cursor = templates.at(-1)!.id;
            if (templates.length < batchSize) break;
            await Bun.sleep(0);
        }
    }
}
