import { TaskRunService } from '@core/services/task-run.service';
import { TaskService } from '@core/services/task.service';
import {
    isProcessAlive,
    isSpawnedProcessTreeAlive,
    signalRecordedProcessTreeWithResult,
    waitForSpawnedProcessTreeExit,
} from '@core/process-control';
import {
    LEGACY_GUARDIAN_LAUNCH_PROTOCOL,
    TOKEN_GUARDIAN_LAUNCH_PROTOCOL,
} from '@core/launch-protocol';

export async function checkHeartbeats(
    heartbeatTimeoutMs: number,
    isOwnedRun: (taskId: number, runId: number) => boolean = () => false,
    shouldStop: () => boolean = () => false,
) {
    const staleRuns = await TaskRunService.getStaleRuns(heartbeatTimeoutMs);
    const result = {
        staleRuns: staleRuns.length,
        recoveredRuns: 0,
        quarantinedRuns: 0,
        failedRuns: 0,
    };
    if (staleRuns.length === 0) return result;

    for (const run of staleRuns) {
        // 让锁心跳、停机信号和 Worker 定时器能在大量隔离记录之间运行；
        // 单次 OS 进程探测有界后，停机最多再等待当前这一条。
        await Bun.sleep(1);
        if (shouldStop()) break;
        if (isOwnedRun(run.taskId, run.runId)) continue;
        try {
            if (run.launchProtocol != null
                && run.launchProtocol !== LEGACY_GUARDIAN_LAUNCH_PROTOCOL
                && run.launchProtocol !== TOKEN_GUARDIAN_LAUNCH_PROTOCOL) {
                console.warn(JSON.stringify({
                    ts: new Date().toISOString(),
                    level: 'warn',
                    msg: 'unknown launch protocol remains quarantined',
                    taskId: run.taskId,
                    runId: run.runId,
                    launchProtocol: run.launchProtocol,
                    remediation: '升级到支持该协议的 SuperTask 版本；禁止使用 run abandon 绕过未知协议',
                }));
                result.quarantinedRuns += 1;
                continue;
            }
            if (run.childPid != null
                && run.launchProtocol !== TOKEN_GUARDIAN_LAUNCH_PROTOCOL) {
                if (!isProcessAlive(run.childPid)
                    && !isSpawnedProcessTreeAlive(run.childPid)) {
                    // 旧协议没有不可复用的进程身份，绝不向存活 PID/PGID 发信号；
                    // 但进程组明确不存在时无需长期隔离，可以安全收敛数据库状态。
                } else {
                    console.warn(JSON.stringify({
                        ts: new Date().toISOString(),
                        level: 'warn',
                        msg: 'stale run has no per-run process identity; run remains quarantined',
                        taskId: run.taskId,
                        runId: run.runId,
                        childPid: run.childPid,
                        launchProtocol: run.launchProtocol,
                        remediation: '旧启动协议不能排除 PID 复用，禁止自动终止；请人工确认进程与数据状态',
                    }));
                    result.quarantinedRuns += 1;
                    continue;
                }
            }
            if (run.childPid == null && run.launchProtocol == null) {
                console.warn(JSON.stringify({
                    ts: new Date().toISOString(),
                    level: 'warn',
                    msg: 'legacy stale run has no recorded child pid; run remains quarantined',
                    taskId: run.taskId,
                    runId: run.runId,
                    remediation: {
                        taskCwd: run.taskCwd,
                        owner: run.ownerAlive
                            ? `owner PID ${run.workerPid} 仍存活，必须先确认并停止对应进程`
                            : 'owner PID 已退出或未记录',
                        cancelCommand: run.taskStatus === 'cancelled'
                            ? null
                            : run.taskCwd == null
                                ? `任务没有记录 cwd，请在 Dashboard 取消任务 #${run.taskId}`
                                : `在 ${run.taskCwd} 执行: supertask cancel --id ${run.taskId}`,
                        abandonCommand: `确认没有遗留 OpenCode 进程后执行: supertask run abandon --id ${run.runId} --confirm ABANDON`,
                    },
                }));
                result.quarantinedRuns += 1;
                continue;
            }
            if (run.childPid != null
                && run.childPid > 0
                && run.launchProtocol === TOKEN_GUARDIAN_LAUNCH_PROTOCOL) {
                const expectedExecutable = process.env.SUPERTASK_OPENCODE_BIN ?? 'opencode';
                const signalResult = signalRecordedProcessTreeWithResult(
                    run.childPid,
                    'SIGKILL',
                    expectedExecutable,
                    run.launchProtocol,
                    run.lockedBy,
                );
                if (signalResult === 'signalled') {
                    const exited = await waitForSpawnedProcessTreeExit(run.childPid);
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
