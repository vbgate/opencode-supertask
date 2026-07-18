import type {
    DatabaseBackupResult,
    DatabaseCheckResult,
    DatabaseClearResult,
    DatabaseCounts,
    DatabaseRestoreResult,
} from '@core/services/database-maintenance.service';
import { cliText, type CliLocale } from './i18n';

export interface GatewayMaintenanceReport {
    wasRunning: boolean;
    restarted: boolean;
    keptStopped: boolean;
}

interface DatabaseResultMap {
    check: DatabaseCheckResult;
    backup: DatabaseBackupResult;
    clear: DatabaseClearResult & { gateway: GatewayMaintenanceReport };
    restore: DatabaseRestoreResult & { gateway: GatewayMaintenanceReport };
}

interface RenderOptions {
    forceJson?: boolean;
    isTTY?: boolean;
    locale?: CliLocale;
}

function useJson(options: RenderOptions): boolean {
    const isTTY = options.isTTY ?? process.stdout.isTTY === true;
    return options.forceJson === true || !isTTY;
}

function formatBytes(bytes: number): string {
    const units = ['B', 'KiB', 'MiB', 'GiB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    const rendered = Number.isInteger(value) ? String(value) : value.toFixed(1);
    return `${rendered} ${units[unit]}`;
}

function formatCounts(counts: DatabaseCounts, locale: CliLocale): string {
    return cliText(
        locale,
        `任务 ${counts.tasks} · 执行记录 ${counts.taskRuns} · 定时任务模板 ${counts.taskTemplates}`,
        `tasks ${counts.tasks} · runs ${counts.taskRuns} · scheduled templates ${counts.taskTemplates}`,
    );
}

function formatGateway(gateway: GatewayMaintenanceReport, locale: CliLocale): string {
    if (gateway.restarted) return cliText(locale, '已自动停止、重启并恢复就绪', 'stopped, restarted, and ready');
    if (gateway.keptStopped) return cliText(locale, '已自动停止，按要求保持停止', 'stopped and left stopped as requested');
    if (!gateway.wasRunning) {
        return cliText(
            locale,
            '无需自动停启（未发现匹配当前数据库的 PM2 Gateway）',
            'no matching PM2 Gateway was running',
        );
    }
    return cliText(locale, '原 Gateway 未恢复运行', 'the previous Gateway was not restored');
}

function formatCheck(result: DatabaseCheckResult, locale: CliLocale): string {
    if (locale === 'en') {
        const lines = [
            result.ok ? '✓ Database check passed' : '✗ Database check failed',
            '',
            `Database: ${result.path}`,
            `Size: ${formatBytes(result.sizeBytes)}`,
            `Journal mode: ${result.journalMode}`,
            `Counts: ${formatCounts(result.counts, locale)}`,
            `Running: tasks ${result.runningTasks} · runs ${result.runningRuns}`,
        ];
        if (!result.ok) {
            lines.push(
                `Integrity: ${result.integrityMessages.join('; ') || 'no result'}`,
                `Foreign-key violations: ${result.foreignKeyViolations}`,
                `Missing tables: ${result.missingTables.join(', ') || 'none'}`,
            );
        }
        return lines.join('\n');
    }
    const lines = [
        result.ok ? '✓ 数据库检查通过' : '✗ 数据库检查未通过',
        '',
        `数据库：${result.path}`,
        `大小：${formatBytes(result.sizeBytes)}`,
        `日志模式：${result.journalMode}`,
        `数据统计：${formatCounts(result.counts, locale)}`,
        `运行中：任务 ${result.runningTasks} · 执行记录 ${result.runningRuns}`,
    ];
    if (!result.ok) {
        lines.push(
            `完整性：${result.integrityMessages.join('；') || '无结果'}`,
            `外键违规：${result.foreignKeyViolations}`,
            `缺失表：${result.missingTables.join('、') || '无'}`,
        );
    }
    return lines.join('\n');
}

function formatHuman<K extends keyof DatabaseResultMap>(
    operation: K,
    result: DatabaseResultMap[K],
    locale: CliLocale,
): string {
    switch (operation) {
        case 'check':
            return formatCheck(result as DatabaseCheckResult, locale);
        case 'backup': {
            const backup = result as DatabaseBackupResult;
            if (locale === 'en') {
                return [
                    '✓ Database backup completed',
                    '',
                    `Backup: ${backup.path}`,
                    `Size: ${formatBytes(backup.sizeBytes)}`,
                    `Counts: ${formatCounts(backup.check.counts, locale)}`,
                    `Integrity: ${backup.check.ok ? 'passed' : 'failed'}`,
                ].join('\n');
            }
            return [
                '✓ 数据库备份完成',
                '',
                `备份文件：${backup.path}`,
                `大小：${formatBytes(backup.sizeBytes)}`,
                `数据统计：${formatCounts(backup.check.counts, locale)}`,
                `数据库完整性：${backup.check.ok ? '通过' : '未通过'}`,
            ].join('\n');
        }
        case 'clear': {
            const cleared = result as DatabaseResultMap['clear'];
            if (locale === 'en') {
                return [
                    '✓ Database safely cleared',
                    '',
                    `Deleted: ${formatCounts(cleared.deleted, locale)}`,
                    `Safety backup: ${cleared.backupPath}`,
                    `Gateway: ${formatGateway(cleared.gateway, locale)}`,
                    `Integrity: ${cleared.check.ok ? 'passed' : 'failed'}`,
                ].join('\n');
            }
            return [
                '✓ 数据库已安全清空',
                '',
                `已删除：${formatCounts(cleared.deleted, locale)}`,
                `安全备份：${cleared.backupPath}`,
                `Gateway：${formatGateway(cleared.gateway, locale)}`,
                `数据库完整性：${cleared.check.ok ? '通过' : '未通过'}`,
            ].join('\n');
        }
        case 'restore': {
            const restored = result as DatabaseResultMap['restore'];
            if (locale === 'en') {
                return [
                    '✓ Database restore completed',
                    '',
                    `Source: ${restored.sourcePath}`,
                    `Pre-restore safety backup: ${restored.safetyBackupPath}`,
                    `Recovered runtime state: tasks ${restored.recoveredRunningTasks} · runs ${restored.closedRunningRuns}`,
                    `Counts: ${formatCounts(restored.check.counts, locale)}`,
                    `Gateway: ${formatGateway(restored.gateway, locale)}`,
                    `Integrity: ${restored.check.ok ? 'passed' : 'failed'}`,
                ].join('\n');
            }
            return [
                '✓ 数据库恢复完成',
                '',
                `恢复来源：${restored.sourcePath}`,
                `恢复前安全备份：${restored.safetyBackupPath}`,
                `运行态收敛：任务 ${restored.recoveredRunningTasks} · 执行记录 ${restored.closedRunningRuns}`,
                `数据统计：${formatCounts(restored.check.counts, locale)}`,
                `Gateway：${formatGateway(restored.gateway, locale)}`,
                `数据库完整性：${restored.check.ok ? '通过' : '未通过'}`,
            ].join('\n');
        }
    }
}

export function renderDatabaseResult<K extends keyof DatabaseResultMap>(
    operation: K,
    result: DatabaseResultMap[K],
    options: RenderOptions = {},
): string {
    return useJson(options)
        ? JSON.stringify(result, null, 2)
        : formatHuman(operation, result, options.locale ?? 'zh-CN');
}

export function renderDatabaseError(error: unknown, options: RenderOptions = {}): string {
    const message = error instanceof Error ? error.message : String(error);
    return useJson(options)
        ? JSON.stringify({ error: message })
        : `✗ ${message}`;
}
