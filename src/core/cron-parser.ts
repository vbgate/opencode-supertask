import { CronExpressionParser } from 'cron-parser';

export function getNextCronRun(expr: string, afterMs?: number): number | null {
    try {
        const fromDate = afterMs != null ? new Date(afterMs) : new Date();
        const interval = CronExpressionParser.parse(expr, { currentDate: fromDate });
        const next = interval.next();
        return next.getTime();
    } catch {
        return null;
    }
}

export function isValidCronExpr(expr: string): boolean {
    try {
        CronExpressionParser.parse(expr);
        return true;
    } catch {
        return false;
    }
}
