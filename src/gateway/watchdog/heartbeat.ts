import { TaskRunService } from '@core/services/task-run.service';
import { TaskService } from '@core/services/task.service';
import {
    signalRecordedProcessTreeWithResult,
    waitForProcessExit,
} from '@core/process-control';

export async function checkHeartbeats(heartbeatTimeoutMs: number) {
    const staleRuns = await TaskRunService.getStaleRuns(heartbeatTimeoutMs);
    const result = {
        staleRuns: staleRuns.length,
        recoveredRuns: 0,
        quarantinedRuns: 0,
        failedRuns: 0,
    };
    if (staleRuns.length === 0) return result;

    for (const run of staleRuns) {
        try {
            if (run.childPid != null && run.childPid > 0) {
                const expectedExecutable = process.env.SUPERTASK_OPENCODE_BIN ?? 'opencode';
                const signalResult = signalRecordedProcessTreeWithResult(
                    run.childPid,
                    'SIGKILL',
                    expectedExecutable,
                );
                if (signalResult === 'signalled') {
                    const exited = await waitForProcessExit(run.childPid);
                    if (!exited) {
                        console.warn(JSON.stringify({
                            ts: new Date().toISOString(),
                            level: 'warn',
                            msg: 'stale child process did not exit; task remains quarantined',
                            taskId: run.taskId,
                            runId: run.runId,
                            childPid: run.childPid,
                        }));
                        result.quarantinedRuns += 1;
                        continue;
                    }
                } else if (signalResult !== 'not-running') {
                    console.warn(JSON.stringify({
                        ts: new Date().toISOString(),
                        level: 'warn',
                        msg: 'stale child process could not be safely terminated; task remains quarantined',
                        taskId: run.taskId,
                        runId: run.runId,
                        childPid: run.childPid,
                        reason: signalResult,
                    }));
                    result.quarantinedRuns += 1;
                    continue;
                }
            }

            const recovery = await TaskService.recoverRun(
                run.taskId,
                run.runId,
                `执行所有者退出或心跳超时 (${heartbeatTimeoutMs / 1000}s)，Watchdog 已确认子进程结束`,
            );
            if (!recovery) continue;
            result.recoveredRuns += 1;

            if (recovery.status === 'dead_letter') {
                console.log(JSON.stringify({
                    ts: new Date().toISOString(),
                    level: 'warn',
                    msg: 'task dead_letter',
                    taskId: run.taskId,
                    runId: run.runId,
                    retryCount: recovery.retryCount,
                    maxRetries: run.taskMaxRetries,
                }));
            } else {
                console.log(JSON.stringify({
                    ts: new Date().toISOString(),
                    level: 'warn',
                    msg: 'task retry scheduled',
                    taskId: run.taskId,
                    runId: run.runId,
                    retryCount: recovery.retryCount,
                    retryAfterMs: recovery.retryAfterMs == null
                        ? null
                        : Math.max(0, recovery.retryAfterMs - Date.now()),
                }));
            }
        } catch (err) {
            result.failedRuns += 1;
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
    return result;
}
