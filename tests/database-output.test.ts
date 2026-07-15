import { describe, expect, test } from 'bun:test';
import {
    renderDatabaseError,
    renderDatabaseResult,
} from '../src/cli/database-output';

const check = {
    ok: true,
    path: '/tmp/任务数据库.db',
    sizeBytes: 294_912,
    journalMode: 'wal',
    integrityMessages: ['ok'],
    foreignKeyViolations: 0,
    missingTables: [],
    counts: { tasks: 376, taskRuns: 243, taskTemplates: 2 },
    runningTasks: 0,
    runningRuns: 0,
};

describe('数据库 CLI 输出格式', () => {
    test('TTY 默认用人类可读格式展示 check', () => {
        const output = renderDatabaseResult('check', check, { isTTY: true });
        expect(output).toContain('✓ 数据库检查通过');
        expect(output).toContain('数据库：/tmp/任务数据库.db');
        expect(output).toContain('大小：288 KiB');
        expect(output).toContain('任务 376 · 执行记录 243 · 调度模板 2');
        expect(output).not.toStartWith('{');
    });

    test('TTY 默认用人类可读格式展示 backup、clear 和 restore', () => {
        const backup = renderDatabaseResult('backup', {
            path: '/tmp/任务备份.db',
            sizeBytes: check.sizeBytes,
            check,
        }, { isTTY: true });
        expect(backup).toContain('✓ 数据库备份完成');
        expect(backup).toContain('备份文件：/tmp/任务备份.db');

        const clear = renderDatabaseResult('clear', {
            backupPath: '/tmp/清空前备份.db',
            deleted: check.counts,
            check: { ...check, counts: { tasks: 0, taskRuns: 0, taskTemplates: 0 } },
            gateway: { wasRunning: true, restarted: true, keptStopped: false },
        }, { isTTY: true });
        expect(clear).toContain('✓ 数据库已安全清空');
        expect(clear).toContain('已删除：任务 376 · 执行记录 243 · 调度模板 2');
        expect(clear).toContain('Gateway：已自动停止、重启并恢复就绪');
        expect(clear).toContain('安全备份：/tmp/清空前备份.db');

        const restore = renderDatabaseResult('restore', {
            sourcePath: '/tmp/恢复来源.db',
            safetyBackupPath: '/tmp/恢复前备份.db',
            recoveredRunningTasks: 2,
            closedRunningRuns: 1,
            check,
            gateway: { wasRunning: true, restarted: false, keptStopped: true },
        }, { isTTY: true });
        expect(restore).toContain('✓ 数据库恢复完成');
        expect(restore).toContain('恢复来源：/tmp/恢复来源.db');
        expect(restore).toContain('运行态收敛：任务 2 · 执行记录 1');
        expect(restore).toContain('Gateway：已自动停止，按要求保持停止');
    });

    test('非 TTY 自动输出 JSON，TTY 传 --json 时也强制 JSON', () => {
        const piped = renderDatabaseResult('check', check, { isTTY: false });
        expect(JSON.parse(piped)).toEqual(check);

        const forced = renderDatabaseResult('check', check, { isTTY: true, forceJson: true });
        expect(JSON.parse(forced)).toEqual(check);
    });

    test('错误同样遵循 TTY 人类格式与 JSON 兼容策略', () => {
        expect(renderDatabaseError(new Error('数据库被占用'), { isTTY: true }))
            .toBe('✗ 数据库被占用');
        expect(JSON.parse(renderDatabaseError(new Error('数据库被占用'), { isTTY: false })))
            .toEqual({ error: '数据库被占用' });
        expect(JSON.parse(renderDatabaseError('数据库被占用', { isTTY: true, forceJson: true })))
            .toEqual({ error: '数据库被占用' });
    });
});
