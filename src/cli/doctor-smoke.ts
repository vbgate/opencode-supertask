import { randomUUID } from 'crypto';
import { resolve } from 'path';
import { TaskService } from '@core/services/task.service';
import { TaskRunService } from '@core/services/task-run.service';

export interface DoctorSmokeOptions {
    agent: string;
    model?: string;
    variant?: string;
    cwd: string;
    timeoutMs: number;
    marker?: string;
    pollIntervalMs?: number;
}

export interface DoctorSmokeResult {
    ok: boolean;
    taskId: number;
    runId: number | null;
    status: string;
    agent: string;
    model: string | null;
    variant: string | null;
    cwd: string;
    durationMs: number;
    error: string | null;
}

function tail(value: string | null | undefined, maxLength = 2_000): string | null {
    if (!value) return null;
    return value.length <= maxLength ? value : value.slice(-maxLength);
}

function extractOpenCodeText(log: string | null | undefined): string {
    if (!log) return '';
    const parts: string[] = [];
    for (const line of log.split('\n')) {
        try {
            const parsed = JSON.parse(line) as {
                type?: unknown;
                part?: { type?: unknown; text?: unknown };
            };
            if (parsed.type === 'text'
                && parsed.part?.type === 'text'
                && typeof parsed.part.text === 'string') {
                parts.push(parsed.part.text);
            }
        } catch {}
    }
    return parts.join('\n').trim();
}

export async function runDoctorSmoke(options: DoctorSmokeOptions): Promise<DoctorSmokeResult> {
    if (!options.agent.trim()) throw new Error('smoke agent 不能为空');
    if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1_000 || options.timeoutMs > 604_800_000) {
        throw new Error('smoke timeout 必须是 1 秒到 7 天之间的整数毫秒值');
    }

    const cwd = resolve(options.cwd);
    const marker = options.marker ?? `SUPERTASK_SMOKE_${randomUUID().replaceAll('-', '').toUpperCase()}`;
    const model = options.model && options.model !== 'default' ? options.model : undefined;
    const variant = options.variant?.trim() || undefined;
    const startedAt = Date.now();
    const task = await TaskService.add({
        name: '[doctor] Gateway real smoke test',
        agent: options.agent,
        model,
        variant,
        prompt: `不要调用任何工具。只回复这一行：${marker}`,
        cwd,
        category: 'diagnostic',
        importance: 5,
        urgency: 5,
        batchId: `doctor-smoke-${randomUUID()}`,
        maxRetries: 0,
        retryBackoffMs: 0,
        timeoutMs: options.timeoutMs,
    });
    const deadline = startedAt + options.timeoutMs;
    const pollIntervalMs = Math.max(10, options.pollIntervalMs ?? 250);

    while (Date.now() < deadline) {
        const current = await TaskService.getById(task.id);
        const run = await TaskRunService.getLatestByTaskId(task.id);
        if (!current) {
            return {
                ok: false,
                taskId: task.id,
                runId: run?.id ?? null,
                status: 'missing',
                agent: options.agent,
                model: model ?? null,
                variant: variant ?? null,
                cwd,
                durationMs: Date.now() - startedAt,
                error: '冒烟任务在完成前被删除',
            };
        }
        if (current.status === 'done') {
            const log = run?.log ?? current.resultLog;
            const markerObserved = extractOpenCodeText(log) === marker;
            return {
                ok: markerObserved,
                taskId: task.id,
                runId: run?.id ?? null,
                status: current.status,
                agent: options.agent,
                model: model ?? null,
                variant: variant ?? null,
                cwd,
                durationMs: Date.now() - startedAt,
                error: markerObserved ? null : 'OpenCode 已退出成功，但模型文本不是预期的精确标记',
            };
        }
        if (current.status === 'dead_letter' || current.status === 'cancelled') {
            return {
                ok: false,
                taskId: task.id,
                runId: run?.id ?? null,
                status: current.status,
                agent: options.agent,
                model: model ?? null,
                variant: variant ?? null,
                cwd,
                durationMs: Date.now() - startedAt,
                error: tail(run?.log ?? current.resultLog) ?? `任务进入 ${current.status}`,
            };
        }
        await Bun.sleep(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
    }

    const current = await TaskService.getById(task.id);
    const run = await TaskRunService.getLatestByTaskId(task.id);
    await TaskService.cancel(task.id);
    return {
        ok: false,
        taskId: task.id,
        runId: run?.id ?? null,
        status: current?.status ?? 'missing',
        agent: options.agent,
        model: model ?? null,
        variant: variant ?? null,
        cwd,
        durationMs: Date.now() - startedAt,
        error: `等待 Gateway 执行超过 ${options.timeoutMs}ms，冒烟任务已请求取消`,
    };
}
