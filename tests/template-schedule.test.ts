import { describe, test, expect } from 'bun:test';
import { TaskTemplateService } from '../src/core/services/task-template.service';
import type { ScheduleType } from '../src/core/db/schema';

describe('calculateNextRunAt', () => {
    test('cron type returns next run based on afterMs', () => {
        const afterMs = new Date('2026-01-15T09:00:00Z').getTime();
        const result = TaskTemplateService.calculateNextRunAt(
            'cron' as ScheduleType,
            { cronExpr: '0 10 * * *', intervalMs: null, runAt: null },
            afterMs,
        );
        expect(result).not.toBeNull();
        expect(result! > afterMs).toBe(true);
    });

    test('cron type with invalid expr returns null', () => {
        const result = TaskTemplateService.calculateNextRunAt(
            'cron' as ScheduleType,
            { cronExpr: 'invalid', intervalMs: null, runAt: null },
        );
        expect(result).toBeNull();
    });

    test('recurring type adds intervalMs to base', () => {
        const base = 1000000;
        const result = TaskTemplateService.calculateNextRunAt(
            'recurring' as ScheduleType,
            { cronExpr: null, intervalMs: 60000, runAt: null },
            base,
        );
        expect(result).toBe(base + 60000);
    });

    test('recurring type without intervalMs returns null', () => {
        const result = TaskTemplateService.calculateNextRunAt(
            'recurring' as ScheduleType,
            { cronExpr: null, intervalMs: null, runAt: null },
        );
        expect(result).toBeNull();
    });

    test('delayed type returns runAt', () => {
        const runAt = Date.now() + 86400_000;
        const result = TaskTemplateService.calculateNextRunAt(
            'delayed' as ScheduleType,
            { cronExpr: null, intervalMs: null, runAt },
        );
        expect(result).toBe(runAt);
    });

    test('delayed type without runAt returns null', () => {
        const result = TaskTemplateService.calculateNextRunAt(
            'delayed' as ScheduleType,
            { cronExpr: null, intervalMs: null, runAt: null },
        );
        expect(result).toBeNull();
    });

    test('unknown scheduleType returns null', () => {
        const result = TaskTemplateService.calculateNextRunAt(
            'unknown' as ScheduleType,
            { cronExpr: null, intervalMs: null, runAt: null },
        );
        expect(result).toBeNull();
    });
});
