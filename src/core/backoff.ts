const MAX_BACKOFF_MS = 30 * 60 * 1000;

export function computeBackoff(
    retryCount: number,
    baseMs = 30000,
    maxMs = MAX_BACKOFF_MS,
): number {
    return Math.min(baseMs * Math.pow(2, retryCount - 1), maxMs);
}
