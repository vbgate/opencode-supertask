import { TaskService } from '@core/services/task.service';
import { TaskRunService } from '@core/services/task-run.service';
import { db, schema } from '@core/db';
import { eq, and, sql } from 'drizzle-orm';

export async function cleanupOldRecords(retentionDays: number) {
    const cutoffSec = Math.floor(Date.now() / 1000) - retentionDays * 86400;
    const { tasks: tasksTable } = schema;

    const oldTasks = await db
        .select({ id: tasksTable.id })
        .from(tasksTable)
        .where(
            and(
                sql`${tasksTable.status} IN ('done', 'failed', 'dead_letter')`,
                sql`${tasksTable.finishedAt} IS NOT NULL`,
                sql`${tasksTable.finishedAt} < ${cutoffSec}`,
            ),
        );

    if (oldTasks.length === 0) return 0;

    const taskIds = oldTasks.map((t) => t.id);
    const deletedRuns = await TaskRunService.deleteByTaskIds(taskIds);
    const deletedTasks = await TaskService.deleteOlderThan(retentionDays);

    console.log(JSON.stringify({
        ts: new Date().toISOString(),
        level: 'info',
        msg: 'cleanup completed',
        deletedTasks,
        deletedRuns,
    }));

    return deletedTasks;
}
