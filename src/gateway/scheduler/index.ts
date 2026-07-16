import { getDueTemplates, cloneTaskFromTemplate, initializeNextRunAt } from './job-templates';
import type { GatewayConfig } from '@gateway/config';
import { db, schema } from '@core/db';
import { isNull } from 'drizzle-orm';
import {
    markGatewayActivity,
    markGatewayFailure,
    markGatewaySuccess,
} from '../health';

export class Scheduler {
    private stopped = false;
    private ticking = false;
    private timer: ReturnType<typeof setInterval> | null = null;

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
            const dueTemplates = await getDueTemplates();
            for (const tmpl of dueTemplates) {
                try {
                    const task = await cloneTaskFromTemplate(tmpl.id);
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
        const templates = await db
            .select()
            .from(taskTemplates)
            .where(isNull(taskTemplates.nextRunAt));

        for (const tmpl of templates) {
            await initializeNextRunAt(tmpl.id);
        }
    }
}
