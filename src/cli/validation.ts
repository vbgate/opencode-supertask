import type { TaskStatus } from '@core/db/schema';

const TASK_STATUSES = new Set<TaskStatus>([
    'pending',
    'running',
    'done',
    'failed',
    'dead_letter',
    'cancelled',
]);

export function parsePositiveInteger(value: string, name: string): number {
    if (!/^\d+$/.test(value)) throw new Error(`${name} 必须是正整数`);
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error(`${name} 必须是正整数`);
    }
    return parsed;
}

export function parseBoundedInteger(
    value: string,
    name: string,
    min: number,
    max: number,
): number {
    if (!/^\d+$/.test(value)) {
        throw new Error(`${name} 必须是 ${min} 到 ${max} 之间的整数`);
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
        throw new Error(`${name} 必须是 ${min} 到 ${max} 之间的整数`);
    }
    return parsed;
}

export function parseTaskStatus(value: string | undefined): TaskStatus | undefined {
    if (value === undefined) return undefined;
    if (!TASK_STATUSES.has(value as TaskStatus)) {
        throw new Error(`status 无效：${value}`);
    }
    return value as TaskStatus;
}
