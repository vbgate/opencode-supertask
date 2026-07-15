import { TaskRunService } from '@core/services/task-run.service';
import { TaskService } from '@core/services/task.service';
import { computeBackoff } from '@core/backoff';

export async function checkHeartbeats(heartbeatTimeoutMs: number) {
    const staleRuns = await TaskRunService.getStaleRuns(heartbeatTimeoutMs);
    if (staleRuns.length === 0) return;

    for (const run of staleRuns) {
        try {
            if (run.childPid != null && run.childPid > 0) {
                try {
                    process.kill(run.childPid, 'SIGKILL');
                } catch {
                }
            }

            await TaskRunService.fail(run.runId, `心跳超时 (${heartbeatTimeoutMs / 1000}s)，Watchdog kill`);

            const newRetryCount = run.taskRetryCount + 1;
            const maxRetries = run.taskMaxRetries;

            if (newRetryCount > maxRetries) {
                await TaskService.markDeadLetter(run.taskId, newRetryCount);
                console.log(JSON.stringify({
                    ts: new Date().toISOString(),
                    level: 'warn',
                    msg: 'task dead_letter',
                    taskId: run.taskId,
                    runId: run.runId,
                    retryCount: newRetryCount,
                    maxRetries,
                }));
            } else {
                const backoffMs = computeBackoff(newRetryCount, run.taskRetryBackoffMs);
                const retryAfter = Date.now() + backoffMs;
                await TaskService.markPendingForRetry(run.taskId, retryAfter, newRetryCount);
                console.log(JSON.stringify({
                    ts: new Date().toISOString(),
                    level: 'warn',
                    msg: 'task retry scheduled',
                    taskId: run.taskId,
                    runId: run.runId,
                    retryCount: newRetryCount,
                    retryAfterMs: backoffMs,
                }));
            }
        } catch (err) {
            console.error(JSON.stringify({
                ts: new Date().toISOString(),
                level: 'error',
                msg: 'failed to process stale run',
                runId: run.runId,
                taskId: run.taskId,
                error: err instanceof Error ? err.message : String(err),
            }));
        }
    }
}
