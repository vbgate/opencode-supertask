import { describe, test, expect } from 'bun:test';
import { getNextCronRun, isValidCronExpr } from '../src/gateway/scheduler/cron-parser';

describe('isValidCronExpr', () => {
    test('valid expressions', () => {
        expect(isValidCronExpr('*/5 * * * *')).toBe(true);
        expect(isValidCronExpr('0 9 * * *')).toBe(true);
        expect(isValidCronExpr('30 */2 * * *')).toBe(true);
        expect(isValidCronExpr('0 0 1 1 *')).toBe(true);
    });

    test('invalid expressions', () => {
        expect(isValidCronExpr('not-a-cron')).toBe(false);
        expect(isValidCronExpr('* * * * * * *')).toBe(false);
    });
});

describe('getNextCronRun', () => {
    test('returns ms timestamp', () => {
        const result = getNextCronRun('*/5 * * * *');
        expect(result).not.toBeNull();
        expect(typeof result).toBe('number');
        expect(result! > 0).toBe(true);
    });

    test('respects afterMs parameter', () => {
        const now = Date.now();
        const futureMs = now + 3600_000;
        const result = getNextCronRun('0 * * * *', futureMs);
        expect(result).not.toBeNull();
        expect(result! >= futureMs).toBe(true);
    });

    test('invalid expr returns null', () => {
        expect(getNextCronRun('invalid')).toBeNull();
    });
});
