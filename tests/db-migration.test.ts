import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { execFileSync, spawn } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const dirs: string[] = [];

afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('数据库迁移入口', () => {
    test('db:migrate 可从源码目录执行并创建最新约束与索引', () => {
        const dir = mkdtempSync(join(tmpdir(), 'supertask-migration-'));
        dirs.push(dir);
        const dbPath = join(dir, 'tasks.db');

        const output = execFileSync('bun', ['run', 'db:migrate'], {
            cwd: process.cwd(),
            env: { ...process.env, SUPERTASK_DB_PATH: dbPath },
            encoding: 'utf8',
        });
        expect(output).toContain('Database migration completed');

        const sqlite = new Database(dbPath);
        const taskColumns = sqlite.query('PRAGMA table_info(tasks)').all() as Array<{ name: string }>;
        const templateColumns = sqlite.query('PRAGMA table_info(task_templates)').all() as Array<{ name: string }>;
        const runColumns = sqlite.query('PRAGMA table_info(task_runs)').all() as Array<{ name: string }>;
        const taskIndexes = sqlite.query('PRAGMA index_list(tasks)').all() as Array<{ name: string }>;
        const runForeignKeys = sqlite.query('PRAGMA foreign_key_list(task_runs)').all() as Array<{ on_delete: string }>;

        expect(taskColumns.some((column) => column.name === 'retry_backoff_ms')).toBe(true);
        expect(taskColumns.some((column) => column.name === 'variant')).toBe(true);
        expect(templateColumns.some((column) => column.name === 'batch_id')).toBe(true);
        expect(templateColumns.some((column) => column.name === 'timeout_ms')).toBe(true);
        expect(templateColumns.some((column) => column.name === 'variant')).toBe(true);
        expect(runColumns.some((column) => column.name === 'variant')).toBe(true);
        expect(taskIndexes.some((item) => item.name === 'tasks_queue_idx')).toBe(true);
        expect(runForeignKeys.some((item) => item.on_delete.toLowerCase() === 'cascade')).toBe(true);
        sqlite.close();
    });
});

describe('并发首次打开数据库', () => {
    test('多个进程同时创建并迁移同一新库时全部成功', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'supertask-concurrent-open-'));
        try {
            const script = join(dir, 'open.ts');
            writeFileSync(script, `const { getDb, closeDb } = await import(${JSON.stringify(join(process.cwd(), 'src/core/db/index.ts'))});\ngetDb();\ncloseDb();\n`);
            for (let round = 0; round < 3; round += 1) {
                const databasePath = join(dir, `round-${round}.db`);
                const exits = await Promise.all(Array.from({ length: 5 }, () => new Promise<number | null>((resolve) => {
                    const child = spawn(process.execPath, [script], {
                        env: { ...process.env, SUPERTASK_DB_PATH: databasePath },
                        stdio: 'ignore',
                    });
                    child.once('close', resolve);
                })));
                expect(exits).toEqual([0, 0, 0, 0, 0]);
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 60_000);
});

