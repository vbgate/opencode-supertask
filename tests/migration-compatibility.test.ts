import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const EXPAND_ONLY_FROM_MIGRATION = 5;

function isBackwardCompatibleStatement(statement: string): boolean {
    const sql = statement.trim().replace(/^--.*$/gm, '').trim();
    if (!sql) return true;
    if (/^CREATE\s+(?!UNIQUE\s+)INDEX\b/i.test(sql)) return true;
    if (/^CREATE\s+TABLE\b/i.test(sql)) return true;
    if (/^ALTER\s+TABLE\b[\s\S]*\bADD\b/i.test(sql)) {
        return !/\bNOT\s+NULL\b/i.test(sql) || /\bDEFAULT\b/i.test(sql);
    }
    return false;
}

describe('数据库迁移回滚兼容性', () => {
    test('0005 起只允许上一版本仍可运行的 expand-only 语句', () => {
        const drizzleDir = join(process.cwd(), 'drizzle');
        const violations = readdirSync(drizzleDir)
            .filter((name) => /^\d{4}_.+\.sql$/.test(name))
            .filter((name) => Number(name.slice(0, 4)) >= EXPAND_ONLY_FROM_MIGRATION)
            .flatMap((name) => readFileSync(join(drizzleDir, name), 'utf8')
                .split('--> statement-breakpoint')
                .filter((statement) => !isBackwardCompatibleStatement(statement))
                .map((statement) => ({ name, statement: statement.trim() })));

        expect(violations).toEqual([]);
    });
});
