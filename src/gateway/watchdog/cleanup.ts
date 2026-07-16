import { TaskService } from '@core/services/task.service';
import { TaskTemplateService } from '@core/services/task-template.service';

export async function cleanupOldRecords(
    retentionDays: number,
    shouldStop: () => boolean = () => false,
) {
    const deletedTasks = await TaskService.deleteOlderThan(retentionDays, shouldStop);
    const deletedDelayedTemplates = await TaskTemplateService.deleteExpiredDelayed(
        retentionDays,
        shouldStop,
    );

    if (deletedTasks > 0 || deletedDelayedTemplates > 0) {
        console.log(JSON.stringify({
            ts: new Date().toISOString(),
            level: 'info',
            msg: 'cleanup completed',
            deletedTasks,
            deletedDelayedTemplates,
        }));
    }

    return deletedTasks;
}
