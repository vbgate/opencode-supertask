import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let tempDir: string;
let testDbPath: string;

function runJson<T>(args: string[]): T {
    const output = execFileSync('bun', ['run', 'src/cli/index.ts', ...args], {
        cwd: process.cwd(),
        encoding: 'utf-8',
        timeout: 15_000,
        env: { ...process.env, SUPERTASK_DB_PATH: testDbPath },
    });
    return JSON.parse(output) as T;
}

function runCommand(args: string[]) {
    return spawnSync('bun', ['run', 'src/cli/index.ts', ...args], {
        cwd: process.cwd(),
        encoding: 'utf-8',
        timeout: 15_000,
        env: { ...process.env, SUPERTASK_DB_PATH: testDbPath },
    });
}

beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'supertask-cli-validation-'));
    testDbPath = join(tempDir, 'tasks.db');
});

afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
});

describe('CLI 输入校验', () => {
    test('拒绝带尾随字符的任务 ID，且不会误删数字前缀对应的任务', () => {
        const task = runJson<{ id: number }>([
            'add', '--name', '不能误删的任务', '--agent', 'test-agent', '--prompt', '验证严格 ID',
        ]);

        const result = runCommand(['delete', '--id', `${task.id}abc`]);
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}${result.stderr}`).toContain('id 必须是正整数');

        expect(runJson<{ id: number }>(['get', '--id', String(task.id)]).id).toBe(task.id);
    });

    test('拒绝未知任务状态、零条列表和被截断的小数优先级', () => {
        for (const args of [
            ['list', '--status', 'finished'],
            ['list', '--limit', '0'],
            ['add', '--name', '错误优先级', '--agent', 'test-agent', '--prompt', '验证整数', '--importance', '3.5'],
        ]) {
            const result = runCommand(args);
            expect(result.status).not.toBe(0);
        }
    });

    test('运行中任务不能被 delete 绕过取消流程', () => {
        const task = runJson<{ id: number }>([
            'add', '--name', '运行中任务', '--agent', 'test-agent', '--prompt', '验证删除保护',
        ]);
        const sqlite = new Database(testDbPath);
        sqlite.query('UPDATE tasks SET status = ?, started_at = ? WHERE id = ?')
            .run('running', Math.floor(Date.now() / 1000), task.id);
        sqlite.close();

        const result = runCommand(['delete', '--id', String(task.id)]);
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}${result.stderr}`).toContain('请先取消任务');
        expect(runJson<{ status: string }>(['get', '--id', String(task.id)]).status).toBe('running');
    });
});

describe('db check 退出语义', () => {
    test('数据库检查结果不通过时输出报告并返回非零退出码', () => {
        const checkDbPath = join(tempDir, 'invalid-schema.db');
        const previousPath = testDbPath;
        testDbPath = checkDbPath;
        try {
            runJson<{ ok: boolean }>(['db', 'check']);
            const sqlite = new Database(checkDbPath);
            sqlite.exec('DROP TABLE task_templates');
            sqlite.close();

            const result = runCommand(['db', 'check', '--json']);
            expect(result.status).not.toBe(0);
            const report = JSON.parse(result.stdout) as { ok: boolean; missingTables: string[] };
            expect(report.ok).toBe(false);
            expect(report.missingTables).toContain('task_templates');
        } finally {
            testDbPath = previousPath;
        }
    });
});
