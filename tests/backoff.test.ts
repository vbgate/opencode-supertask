import { describe, test, expect } from 'bun:test';
import { computeBackoff } from '../src/core/backoff';

describe('computeBackoff', () => {
    test('retryCount=1 → baseMs', () => {
        expect(computeBackoff(1)).toBe(30000);
    });

    test('retryCount=2 → 2x base', () => {
        expect(computeBackoff(2)).toBe(60000);
    });

    test('retryCount=3 → 4x base', () => {
        expect(computeBackoff(3)).toBe(120000);
    });

    test('retryCount=5 → 16x base', () => {
        expect(computeBackoff(5)).toBe(480000);
    });

    test('capped at maxMs (30min)', () => {
        expect(computeBackoff(10)).toBe(30 * 60 * 1000);
        expect(computeBackoff(20)).toBe(30 * 60 * 1000);
    });

    test('custom baseMs and maxMs', () => {
        expect(computeBackoff(1, 10000, 60000)).toBe(10000);
        expect(computeBackoff(3, 10000, 60000)).toBe(40000);
        expect(computeBackoff(5, 10000, 60000)).toBe(60000);
    });
});
