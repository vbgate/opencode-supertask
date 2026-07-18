// SQLite trim() defaults to U+0020 only. Keep database compatibility queries
// aligned with ECMAScript String.trim() for legacy, unnormalized rows.
export const TASK_BATCH_TRIM_CHARACTERS = ' \t\n\v\f\r\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';

export function normalizeTaskBatchId(
    batchId: string | null | undefined,
): string | null | undefined {
    if (batchId == null) return batchId;
    return batchId.trim() || null;
}
