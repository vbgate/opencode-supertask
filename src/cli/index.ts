import { Command, Option } from 'commander';
import { TaskService, type EditableTaskUpdate } from '@core/services/task.service';
import { TaskRunService } from '@core/services/task-run.service';
import { TaskTemplateService } from '@core/services/task-template.service';
import { DatabaseMaintenanceService } from '@core/services/database-maintenance.service';
import { closeDb } from '@core/db';
import { parseDuration } from '@core/duration';
import type { ScheduleType } from '@core/db/schema';
import {
    getGatewayDiagnostic,
    getPackageVersion,
    withGatewayMaintenance,
} from '../daemon/pm2';
import { getConfigPath, loadConfig } from '@gateway/config';
import { spawnSync } from 'child_process';
import {
    renderDatabaseError,
    renderDatabaseResult,
    type GatewayMaintenanceReport,
} from './database-output';
import {
    parseBoundedInteger,
    parsePositiveInteger,
    parseTaskStatus,
} from './validation';
import { getOpenCodePluginDiagnostic } from '../daemon/update';
import { cliText, resolveCliLocale } from './i18n';

const cliLocale = resolveCliLocale();
const t = (zh: string, en: string): string => cliText(cliLocale, zh, en);

async function withDb<T>(
    fn: () => Promise<T>,
    formatError = (error: unknown) => JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
    }),
): Promise<T> {
    try {
        return await fn();
    } catch (error) {
        console.error(formatError(error));
        closeDb();
        process.exit(1);
    } finally {
        closeDb();
    }
}

function runDestructiveDatabaseMaintenance<T extends object>(
    keepStopped: boolean,
    operation: () => T,
): T & { gateway: GatewayMaintenanceReport } {
    const maintenance = withGatewayMaintenance(keepStopped, operation);

    return {
        ...maintenance.result,
        gateway: {
            wasRunning: maintenance.wasRunning,
            restarted: maintenance.restarted,
            keptStopped: maintenance.keptStopped,
        },
    };
}

const program = new Command();

program
    .name('supertask')
    .description(t('面向 OpenCode Agent 的持久化任务队列与定时任务系统', 'Durable task queue and scheduler for OpenCode agents'))
    .addOption(new Option('--lang <language>', t('CLI 语言：auto / zh-CN / en', 'CLI language: auto / zh-CN / en'))
        .choices(['auto', 'zh-CN', 'en'])
        .default('auto'))
    .helpOption('-h, --help', t('显示帮助', 'display help for command'))
    .addHelpCommand('help [command]', t('显示命令帮助', 'display help for command'))
    .version(getPackageVersion(), '-V, --version', t('显示版本号', 'output the version number'));

if (cliLocale === 'zh-CN') {
    program.configureOutput({
        writeOut: (value) => process.stdout.write(value
            .replace(/^Usage:/gm, '用法：')
            .replace(/^Options:/gm, '选项：')
            .replace(/^Commands:/gm, '命令：')
            .replace(/^Arguments:/gm, '参数：')),
    });
}

program
    .command('add')
    .description(t('创建新任务', 'create a queued task'))
    .requiredOption('-n, --name <name>', t('任务名称', 'task name'))
    .requiredOption('-a, --agent <agent>', t('主 Agent 名称', 'primary agent name'))
    .requiredOption('-p, --prompt <prompt>', t('提示词', 'prompt'))
    .option('-m, --model <model>', t('模型', 'model'))
    .option('-c, --category <category>', t('分类', 'category'), 'general')
    .option('-i, --importance <number>', t('重要程度 (1-5)', 'importance (1-5)'), '3')
    .option('-u, --urgency <number>', t('紧急程度 (1-5)', 'urgency (1-5)'), '3')
    .option('-b, --batch <batchId>', t('批次 ID', 'batch ID'))
    .option('-d, --depends <taskId>', t('依赖的任务 ID', 'dependency task ID'))
    .option('--max-retries <number>', t('首次执行之外允许的重试次数', 'retries allowed after the first attempt'), '3')
    .option('--retry-backoff <duration>', t('重试退避基础间隔，如 30s / 5min', 'retry backoff base, e.g. 30s / 5min'), '30s')
    .option('--timeout <duration>', t('任务硬超时，如 30min / 2h', 'hard timeout, e.g. 30min / 2h'))
    .option('-w, --cwd <path>', t('(已废弃) 系统会自动记录提交时的当前目录', '(deprecated) the submission directory is recorded automatically'))
    .action(async (options) => withDb(async () => {
        const submitCwd = process.cwd();
        const retryBackoffMs = parseDuration(options.retryBackoff);
        const timeoutMs = options.timeout ? parseDuration(options.timeout) : null;
        if (retryBackoffMs === null || (options.timeout && timeoutMs === null)) {
            throw new Error('retry-backoff 或 timeout 格式无效');
        }
        const task = await TaskService.add({
            name: options.name,
            agent: options.agent,
            prompt: options.prompt,
            model: options.model,
            category: options.category,
            importance: parseBoundedInteger(options.importance, 'importance', 1, 5),
            urgency: parseBoundedInteger(options.urgency, 'urgency', 1, 5),
            batchId: options.batch,
            dependsOn: options.depends ? parsePositiveInteger(options.depends, 'depends') : undefined,
            cwd: submitCwd,
            maxRetries: parseBoundedInteger(options.maxRetries, 'max-retries', 0, 1000),
            retryBackoffMs,
            timeoutMs,
        });
        console.log(JSON.stringify({ id: task.id, status: 'created' }, null, 2));
    }));

program
    .command('edit')
    .description(t('修改当前项目中尚未完成的任务', 'edit an unfinished task in the current project'))
    .requiredOption('--id <id>', t('任务 ID', 'task ID'))
    .option('-n, --name <name>', t('任务名称', 'task name'))
    .option('-a, --agent <agent>', t('Agent 名称', 'agent name'))
    .option('-m, --model <model>', t('模型', 'model'))
    .option('-p, --prompt <prompt>', t('提示词', 'prompt'))
    .option('-c, --category <category>', t('分类', 'category'))
    .option('-i, --importance <number>', t('重要程度 (1-5)', 'importance (1-5)'))
    .option('-u, --urgency <number>', t('紧急程度 (1-5)', 'urgency (1-5)'))
    .option('-b, --batch <batchId>', t('批次 ID', 'batch ID'))
    .option('--clear-batch', t('清空批次 ID', 'clear the batch ID'))
    .option('--max-retries <number>', t('首次执行之外允许的重试次数', 'retries allowed after the first attempt'))
    .option('--retry-backoff <duration>', t('重试退避基础间隔，如 30s / 5min', 'retry backoff base, e.g. 30s / 5min'))
    .option('--timeout <duration>', t('任务硬超时，如 30min / 2h', 'hard timeout, e.g. 30min / 2h'))
    .option('--clear-timeout', t('清空任务级超时，改用 Gateway 默认值', 'clear the task timeout and use the Gateway default'))
    .action(async (options) => withDb(async () => {
        if (options.batch !== undefined && options.clearBatch) {
            throw new Error('batch 和 clear-batch 不能同时使用');
        }
        if (options.timeout !== undefined && options.clearTimeout) {
            throw new Error('timeout 和 clear-timeout 不能同时使用');
        }
        const update: EditableTaskUpdate = {};
        for (const field of ['name', 'agent', 'model', 'prompt', 'category'] as const) {
            if (options[field] !== undefined) update[field] = options[field];
        }
        if (options.importance !== undefined) {
            update.importance = parseBoundedInteger(options.importance, 'importance', 1, 5);
        }
        if (options.urgency !== undefined) {
            update.urgency = parseBoundedInteger(options.urgency, 'urgency', 1, 5);
        }
        if (options.maxRetries !== undefined) {
            update.maxRetries = parseBoundedInteger(options.maxRetries, 'max-retries', 0, 1000);
        }
        if (options.batch !== undefined || options.clearBatch) {
            update.batchId = options.clearBatch ? null : options.batch;
        }
        if (options.retryBackoff !== undefined) {
            const retryBackoffMs = parseDuration(options.retryBackoff);
            if (retryBackoffMs === null) throw new Error('retry-backoff 格式无效');
            update.retryBackoffMs = retryBackoffMs;
        }
        if (options.timeout !== undefined || options.clearTimeout) {
            const timeoutMs = options.clearTimeout ? null : parseDuration(options.timeout);
            if (timeoutMs === null && !options.clearTimeout) throw new Error('timeout 格式无效');
            update.timeoutMs = timeoutMs;
        }
        const id = parsePositiveInteger(options.id, 'id');
        const task = await TaskService.update(id, update, { cwd: process.cwd() });
        if (!task) throw new Error(`任务 #${id} 不存在于当前项目，或其状态不允许编辑`);
        console.log(JSON.stringify({ id: task.id, status: task.status, updated: true }, null, 2));
    }));

program
    .command('next')
    .description(t('获取下一个待执行的任务', 'show the next runnable task'))
    .action(async () => withDb(async () => {
        const task = await TaskService.next({ cwd: process.cwd() });
        if (task) {
            console.log(JSON.stringify({
                id: task.id,
                name: task.name,
                agent: task.agent,
                model: task.model,
                prompt: task.prompt,
                cwd: task.cwd,
                category: task.category,
                importance: task.importance,
                urgency: task.urgency,
            }, null, 2));
        } else {
            console.log(JSON.stringify({ id: null, message: 'No executable tasks' }));
        }
    }));

program
    .command('cancel')
    .description(t('取消任务', 'cancel a task'))
    .requiredOption('--id <id>', t('任务 ID', 'task ID'))
    .action(async (options) => withDb(async () => {
        const task = await TaskService.cancel(parsePositiveInteger(options.id, 'id'), { cwd: process.cwd() });
        if (task) {
            console.log(JSON.stringify({ id: task.id, status: task.status }));
        } else {
            console.log(JSON.stringify({ error: 'Task not found' }));
            process.exit(1);
        }
    }));

const runCommand = new Command('run')
    .description(t('管理隔离的执行记录', 'manage quarantined task runs'));

runCommand
    .command('abandon')
    .description(t('人工关闭已确认不存在遗留进程的旧版无 PID 隔离记录', 'close a legacy no-PID quarantine after confirming no process remains'))
    .requiredOption('--id <id>', t('执行记录 run ID', 'run ID'))
    .option('--confirm <word>', t('危险操作确认，必须填写 ABANDON', 'confirmation word; must be ABANDON'))
    .action(async (options: { id: string; confirm?: string }) => withDb(async () => {
        if (options.confirm !== 'ABANDON') {
            throw new Error('关闭旧版隔离 run 必须显式传入 --confirm ABANDON');
        }
        const runId = parsePositiveInteger(options.id, 'id');
        const result = await TaskRunService.abandonLegacyRun(runId);
        if (!result) throw new Error(`run #${runId} 不存在`);
        console.log(JSON.stringify(result, null, 2));
    }));

program.addCommand(runCommand);

program
    .command('retry')
    .description(t('重试失败的任务', 'retry failed tasks'))
    .option('--id <id>', t('任务 ID', 'task ID'))
    .option('-b, --batch <batchId>', t('批次 ID（批量重试）', 'batch ID for bulk retry'))
    .action(async (options) => withDb(async () => {
        if (options.id) {
            const task = await TaskService.retry(parsePositiveInteger(options.id, 'id'), { cwd: process.cwd() });
            if (task) {
                console.log(JSON.stringify({ id: task.id, status: task.status }));
            } else {
                console.log(JSON.stringify({ error: 'Task not found or not failed' }));
                process.exit(1);
            }
        } else if (options.batch) {
            const count = await TaskService.retryBatch(options.batch, { cwd: process.cwd() });
            console.log(JSON.stringify({ retried: count, batchId: options.batch }));
        } else {
            console.log(JSON.stringify({ error: 'Please specify --id or --batch' }));
            process.exit(1);
        }
    }));

program
    .command('status')
    .description(t('查看任务统计', 'show task counts'))
    .option('-b, --batch <batchId>', t('按批次统计', 'filter counts by batch'))
    .action(async (options) => withDb(async () => {
        const stats = await TaskService.stats({ batchId: options.batch, cwd: process.cwd() });
        console.log(JSON.stringify(stats, null, 2));
    }));

program
    .command('list')
    .description(t('列出任务', 'list tasks'))
    .option('-s, --status <status>', t('按状态筛选', 'filter by status'))
    .option('-b, --batch <batchId>', t('按批次筛选', 'filter by batch'))
    .option('-c, --category <category>', t('按分类筛选', 'filter by category'))
    .option('-l, --limit <number>', t('限制数量', 'maximum rows'), '20')
    .action(async (options) => withDb(async () => {
        const tasks = await TaskService.list({
            status: parseTaskStatus(options.status),
            batchId: options.batch,
            category: options.category,
            cwd: process.cwd(),
            limit: parsePositiveInteger(options.limit, 'limit'),
        });
        console.log(JSON.stringify(tasks, null, 2));
    }));

program
    .command('get')
    .description(t('获取单个任务详情', 'show one task'))
    .requiredOption('--id <id>', t('任务 ID', 'task ID'))
    .action(async (options) => withDb(async () => {
        const task = await TaskService.getById(parsePositiveInteger(options.id, 'id'), { cwd: process.cwd() });
        if (task) {
            console.log(JSON.stringify(task, null, 2));
        } else {
            console.log(JSON.stringify({ error: 'Task not found' }));
            process.exit(1);
        }
    }));

program
    .command('delete')
    .description(t('删除任务', 'delete a task'))
    .requiredOption('--id <id>', t('任务 ID', 'task ID'))
    .action(async (options) => withDb(async () => {
        const id = parsePositiveInteger(options.id, 'id');
        const deleted = await TaskService.delete(id, { cwd: process.cwd() });
        console.log(JSON.stringify({ deleted, id }));
    }));

program
    .command('template')
    .description(t('管理定时任务模板', 'manage scheduled task templates'))
    .addCommand(
        new Command('add')
            .description(t('创建定时任务模板', 'create a scheduled task template'))
            .requiredOption('-n, --name <name>', t('模板名称', 'template name'))
            .requiredOption('-a, --agent <agent>', t('Agent 名称', 'agent name'))
            .requiredOption('-p, --prompt <prompt>', t('提示词', 'prompt'))
            .requiredOption('-t, --type <type>', t('定时类型：cron/delayed/recurring', 'schedule type: cron/delayed/recurring'))
            .option('--cron <expr>', t('cron 表达式（cron 类型必填）', 'cron expression (required for cron)'))
            .option('--delay <duration>', t('延迟时间（delayed 必填），如 30s / 5min / 1h / 2d', 'delay (required for delayed), e.g. 30s / 5min / 1h / 2d'))
            .option('--interval <duration>', t('循环间隔（recurring 必填），如 1h / 30min / 5s', 'interval (required for recurring), e.g. 1h / 30min / 5s'))
            .option('-m, --model <model>', t('模型', 'model'))
            .option('-c, --category <category>', t('分类', 'category'), 'general')
            .option('-i, --importance <number>', t('重要程度 1-5', 'importance 1-5'), '3')
            .option('-u, --urgency <number>', t('紧急程度 1-5', 'urgency 1-5'), '3')
            .option('-b, --batch <batchId>', t('模板生成任务的批次 ID', 'batch ID for generated tasks'))
            .option('--max-instances <number>', t('自动定时任务的活跃实例上限（立即触发不受限）', 'active instance limit for automatic scheduling (Run now is unrestricted)'), '1')
            .option('--max-retries <number>', t('最大重试次数', 'maximum retries'), '3')
            .option('--retry-backoff <duration>', t('退避基础间隔，如 30s / 5min', 'retry backoff base, e.g. 30s / 5min'), '30s')
            .option('--timeout <duration>', t('每次任务硬超时，如 30min / 2h', 'hard timeout per task, e.g. 30min / 2h'))
            .action(async (options) => withDb(async () => {
                let intervalMs: number | null = null;
                let runAt: number | null = null;
                const retryBackoffMs = parseDuration(options.retryBackoff);
                const timeoutMs = options.timeout ? parseDuration(options.timeout) : null;

                if (retryBackoffMs === null || (options.timeout && timeoutMs === null)) {
                    throw new Error('retry-backoff 或 timeout 格式无效');
                }

                if (options.interval) {
                    intervalMs = parseDuration(options.interval);
                    if (intervalMs === null) {
                        console.error(JSON.stringify({ error: `Invalid interval: "${options.interval}". Use 30s / 5min / 1h / 2d` }));
                        process.exit(1);
                    }
                }
                if (options.delay) {
                    const delayMs = parseDuration(options.delay);
                    if (delayMs === null) {
                        console.error(JSON.stringify({ error: `Invalid delay: "${options.delay}". Use 30s / 5min / 1h / 2d` }));
                        process.exit(1);
                    }
                    runAt = Date.now() + delayMs;
                }

                const tmpl = await TaskTemplateService.create({
                    name: options.name,
                    agent: options.agent,
                    prompt: options.prompt,
                    model: options.model,
                    category: options.category,
                    importance: parseBoundedInteger(options.importance, 'importance', 1, 5),
                    urgency: parseBoundedInteger(options.urgency, 'urgency', 1, 5),
                    cwd: process.cwd(),
                    batchId: options.batch,
                    scheduleType: options.type as ScheduleType,
                    cronExpr: options.cron,
                    intervalMs,
                    runAt,
                    maxInstances: parseBoundedInteger(options.maxInstances, 'max-instances', 1, 1000),
                    maxRetries: parseBoundedInteger(options.maxRetries, 'max-retries', 0, 1000),
                    retryBackoffMs,
                    timeoutMs,
                });
                console.log(JSON.stringify({ id: tmpl.id, status: 'created', nextRunAt: tmpl.nextRunAt }, null, 2));
            })),
    )
    .addCommand(
        new Command('list')
            .description(t('列出定时任务模板', 'list scheduled task templates'))
            .action(async () => withDb(async () => {
                const templates = await TaskTemplateService.list();
                console.log(JSON.stringify(templates, null, 2));
            })),
    )
    .addCommand(
        new Command('enable')
            .description(t('启用模板', 'enable a template'))
            .requiredOption('--id <id>', t('模板 ID', 'template ID'))
            .action(async (options) => withDb(async () => {
                const tmpl = await TaskTemplateService.enable(parsePositiveInteger(options.id, 'id'));
                if (tmpl) {
                    console.log(JSON.stringify({ id: tmpl.id, enabled: true }));
                } else {
                    console.log(JSON.stringify({ error: 'Template not found' }));
                    process.exit(1);
                }
            })),
    )
    .addCommand(
        new Command('disable')
            .description(t('禁用模板', 'disable a template'))
            .requiredOption('--id <id>', t('模板 ID', 'template ID'))
            .action(async (options) => withDb(async () => {
                const tmpl = await TaskTemplateService.disable(parsePositiveInteger(options.id, 'id'));
                if (tmpl) {
                    console.log(JSON.stringify({ id: tmpl.id, enabled: false }));
                } else {
                    console.log(JSON.stringify({ error: 'Template not found' }));
                    process.exit(1);
                }
            })),
    )
    .addCommand(
        new Command('delete')
            .description(t('删除模板', 'delete a template'))
            .requiredOption('--id <id>', t('模板 ID', 'template ID'))
            .action(async (options) => withDb(async () => {
                const id = parsePositiveInteger(options.id, 'id');
                const deleted = await TaskTemplateService.delete(id);
                console.log(JSON.stringify({ deleted, id }));
            })),
    );

const databaseCommand = new Command('db')
    .description(t('数据库检查、备份、清空与恢复', 'check, back up, clear, and restore the database'));

databaseCommand
    .command('check')
    .description(t('检查数据库完整性、外键和业务表统计', 'check integrity, foreign keys, and table counts'))
    .option('--json', t('强制输出 JSON（非交互调用默认已输出 JSON）', 'force JSON output (already the default when non-interactive)'))
    .action(async (options: { json?: boolean }) => withDb(async () => {
        const result = DatabaseMaintenanceService.check();
        console.log(renderDatabaseResult('check', result, { forceJson: options.json, locale: cliLocale }));
        if (!result.ok) process.exitCode = 1;
    }, (error) => renderDatabaseError(error, { forceJson: options.json })));

databaseCommand
    .command('backup')
    .description(t('创建经过完整性校验的一致性备份', 'create a consistent, integrity-checked backup'))
    .option('-o, --output <path>', t('备份文件路径（默认写入数据库目录）', 'backup path (defaults to the database directory)'))
    .option('--json', t('强制输出 JSON（非交互调用默认已输出 JSON）', 'force JSON output (already the default when non-interactive)'))
    .action(async (options: { output?: string; json?: boolean }) => withDb(async () => {
        const result = DatabaseMaintenanceService.backup(options.output);
        console.log(renderDatabaseResult('backup', result, { forceJson: options.json, locale: cliLocale }));
    }, (error) => renderDatabaseError(error, { forceJson: options.json })));

databaseCommand
    .command('clear')
    .description(t('备份后事务性清空任务、执行记录和定时任务模板', 'back up, then transactionally clear tasks, runs, and scheduled templates'))
    .option('--confirm <word>', t('危险操作确认，必须填写 CLEAR', 'confirmation word; must be CLEAR'))
    .option('--keep-stopped', t('维护结束后不重启原本由 PM2 管理的 Gateway', 'leave a previously managed Gateway stopped'))
    .option('--json', t('强制输出 JSON（非交互调用默认已输出 JSON）', 'force JSON output (already the default when non-interactive)'))
    .action(async (options: { confirm?: string; keepStopped?: boolean; json?: boolean }) => withDb(async () => {
        if (options.confirm !== 'CLEAR') {
            throw new Error('清空数据库必须显式传入 --confirm CLEAR');
        }
        const result = runDestructiveDatabaseMaintenance(
            options.keepStopped ?? false,
            () => DatabaseMaintenanceService.clear(),
        );
        console.log(renderDatabaseResult('clear', result, { forceJson: options.json, locale: cliLocale }));
    }, (error) => renderDatabaseError(error, { forceJson: options.json })));

databaseCommand
    .command('restore')
    .description(t('自动备份当前库后，从指定备份恢复数据库', 'back up the live database, then restore from a backup'))
    .requiredOption('--from <path>', t('要恢复的 SQLite 备份文件', 'SQLite backup to restore'))
    .option('--confirm <word>', t('危险操作确认，必须填写 RESTORE', 'confirmation word; must be RESTORE'))
    .option('--keep-stopped', t('维护结束后不重启原本由 PM2 管理的 Gateway', 'leave a previously managed Gateway stopped'))
    .option('--json', t('强制输出 JSON（非交互调用默认已输出 JSON）', 'force JSON output (already the default when non-interactive)'))
    .action(async (options: { from: string; confirm?: string; keepStopped?: boolean; json?: boolean }) => withDb(async () => {
        if (options.confirm !== 'RESTORE') {
            throw new Error('恢复数据库必须显式传入 --confirm RESTORE');
        }
        const result = runDestructiveDatabaseMaintenance(
            options.keepStopped ?? false,
            () => DatabaseMaintenanceService.restore(options.from),
        );
        console.log(renderDatabaseResult('restore', result, { forceJson: options.json, locale: cliLocale }));
    }, (error) => renderDatabaseError(error, { forceJson: options.json })));

program.addCommand(databaseCommand);

program
    .command('init')
    .description(t('初始化 SuperTask（创建配置并执行迁移）', 'initialize SuperTask (create config and run migrations)'))
    .action(async () => withDb(async () => {
        const { existsSync, mkdirSync, writeFileSync } = await import('fs');
        const { dirname } = await import('path');
        const { getConfigPath } = await import('@gateway/config');
        const configPath = getConfigPath();

        if (!existsSync(configPath)) {
            const dir = dirname(configPath);
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            writeFileSync(configPath, JSON.stringify({
                configVersion: 2,
                worker: { maxConcurrency: 2 },
                scheduler: { enabled: true },
            }, null, 2) + '\n');
            console.log(JSON.stringify({ created: configPath }));
        } else {
            console.log(JSON.stringify({ exists: configPath }));
        }

        const { getDb } = await import('@core/db');
        getDb();
        console.log(JSON.stringify({ migrated: true }));
    }));

program
    .command('migrate')
    .description(t('执行数据库迁移', 'run database migrations'))
    .action(async () => withDb(async () => {
        const { getDb } = await import('@core/db');
        getDb();
        console.log(JSON.stringify({ migrated: true }));
    }));

program
    .command('gateway')
    .description(t('在前台启动 Gateway', 'start the Gateway in the foreground'))
    .action(async () => {
        const { main } = await import('@gateway/index');
        await main();
    });

program
    .command('ui')
    .description(t('打开 Gateway 内置的 Web 管理界面', 'open the Web Dashboard embedded in the Gateway'))
    .action(async () => {
        const { loadConfig } = await import('@gateway/config');
        const cfg = loadConfig();
        const url = `http://localhost:${cfg.dashboard.port}`;
        console.log(`Dashboard: ${url}`);
        try {
            const { execSync } = await import('child_process');
            const cmd = process.platform === 'win32' ? `start ${url}` : process.platform === 'darwin' ? `open ${url}` : `xdg-open ${url}`;
            execSync(cmd, { stdio: 'ignore' });
        } catch {}
    });

program
    .command('config')
    .description(t('显示当前配置', 'show the current configuration'))
    .action(async () => {
        const { loadConfig } = await import('@gateway/config');
        const cfg = loadConfig();
        console.log(JSON.stringify(cfg, null, 2));
    });

program
    .command('doctor')
    .description(t('检查 OpenCode、数据库、Gateway、Web 界面和日志轮转', 'diagnose OpenCode, database, Gateway, Dashboard, and log rotation'))
    .option('--json', t('强制输出 JSON', 'force JSON output'))
    .action(async (options: { json?: boolean }) => withDb(async () => {
        const config = loadConfig();
        const database = DatabaseMaintenanceService.check();
        const legacyQuarantinedRuns = await TaskRunService.listLegacyQuarantinedRuns(
            config.watchdog.heartbeatTimeoutMs,
        );
        const gateway = getGatewayDiagnostic();
        const packageVersion = getPackageVersion();
        const opencodeBin = process.env.SUPERTASK_OPENCODE_BIN ?? 'opencode';
        const opencodeResult = spawnSync(opencodeBin, ['--version'], {
            encoding: 'utf8',
            env: process.env,
        });
        const opencode = {
            ok: opencodeResult.status === 0,
            executable: opencodeBin,
            version: opencodeResult.status === 0
                ? opencodeResult.stdout.trim()
                : null,
            error: opencodeResult.status === 0
                ? null
                : (opencodeResult.error?.message || opencodeResult.stderr.trim() || t(`退出码 ${opencodeResult.status}`, `exit code ${opencodeResult.status}`)),
        };
        const plugin = getOpenCodePluginDiagnostic();

        let dashboard: { enabled: boolean; ok: boolean; url: string; status: number | null; error: string | null } = {
            enabled: config.dashboard.enabled,
            ok: !config.dashboard.enabled,
            url: `http://127.0.0.1:${config.dashboard.port}/health`,
            status: null,
            error: null,
        };
        if (config.dashboard.enabled) {
            try {
                const response = await fetch(dashboard.url, { signal: AbortSignal.timeout(2000) });
                dashboard = { ...dashboard, ok: response.ok, status: response.status };
            } catch (error) {
                dashboard = {
                    ...dashboard,
                    error: error instanceof Error ? error.message : String(error),
                };
            }
        }

        const warnings: string[] = [];
        const gatewayEntryPinned = gateway.gatewayEntry === null
            || !/[\\/]opencode-supertask@(latest|next)[\\/]/.test(gateway.gatewayEntry);
        const gatewayVersionMatchesPackage = gateway.gatewayPackageVersion !== null
            && gateway.runningVersion === gateway.gatewayPackageVersion;
        const configuredVersionsMatch = plugin.ok
            && plugin.version === gateway.gatewayPackageVersion;
        const cliVersionMatchesPlugin = plugin.ok
            && plugin.version === packageVersion;
        if (!plugin.ok && plugin.error) {
            warnings.push(plugin.error);
        }
        if (plugin.version !== null && plugin.version !== packageVersion) {
            warnings.push(t(
                `当前 CLI v${packageVersion} 与 OpenCode 插件 v${plugin.version} 不一致；执行 supertask upgrade 让 CLI、插件和 Gateway 收敛到同一精确版本`,
                `CLI v${packageVersion} does not match OpenCode plugin v${plugin.version}; run supertask upgrade to converge the CLI, plugin, and Gateway on one exact version`,
            ));
        }
        if (!gatewayEntryPinned) {
            warnings.push(t(
                `PM2 Gateway 仍从浮动缓存路径启动：${gateway.gatewayEntry}`,
                `The PM2 Gateway still starts from a floating cache path: ${gateway.gatewayEntry}`,
            ));
        }
        if (gateway.processFound && gateway.gatewayPackageVersion === null) {
            warnings.push(t(
                `无法从 PM2 Gateway 入口确认 opencode-supertask 包版本：${gateway.gatewayEntry ?? 'unknown'}`,
                `Could not determine the opencode-supertask package version from the PM2 Gateway entry: ${gateway.gatewayEntry ?? 'unknown'}`,
            ));
        } else if (gateway.processFound && !gatewayVersionMatchesPackage) {
            warnings.push(t(
                `Gateway ready 锁版本 ${gateway.runningVersion ?? 'unknown'} 与入口包版本 ${gateway.gatewayPackageVersion ?? 'unknown'} 不一致`,
                `Gateway ready-lock version ${gateway.runningVersion ?? 'unknown'} does not match entry package version ${gateway.gatewayPackageVersion ?? 'unknown'}`,
            ));
        }
        if (plugin.version !== null && gateway.gatewayPackageVersion !== null
            && plugin.version !== gateway.gatewayPackageVersion) {
            warnings.push(t(
                `OpenCode 插件 v${plugin.version} 与 PM2 Gateway v${gateway.gatewayPackageVersion} 不一致；执行 supertask upgrade`,
                `OpenCode plugin v${plugin.version} does not match PM2 Gateway v${gateway.gatewayPackageVersion}; run supertask upgrade`,
            ));
        }
        if (gateway.pm2Installed && !gateway.logRotationInstalled) {
            warnings.push(t(
                '未检测到 pm2-logrotate；长期运行前建议安装并限制日志保留量',
                'pm2-logrotate was not detected; install it and limit log retention before long-running use',
            ));
        }
        if (gateway.startupConfigured === false) {
            warnings.push(process.platform === 'linux'
                ? t('未检测到已启用且包含可恢复 PM2 dump 的 systemd 自启服务', 'No enabled systemd startup service with a recoverable PM2 dump was detected')
                : t('未检测到正在运行且包含可恢复 PM2 dump 的 macOS LaunchAgent', 'No running macOS LaunchAgent with a recoverable PM2 dump was detected'));
        }
        if (gateway.processFound && !gateway.scopeMatches) {
            warnings.push(t(
                '当前 CLI/OpenCode 与 PM2 Gateway 的数据库、配置或 OpenCode 可执行文件作用域不一致',
                'The current CLI/OpenCode database, config, or OpenCode executable scope does not match the PM2 Gateway',
            ));
        }
        for (const run of legacyQuarantinedRuns) {
            const cwdHint = run.taskCwd == null
                ? t('（旧任务没有 cwd，请先在 Dashboard 取消）', ' (the legacy task has no cwd; cancel it in the Dashboard first)')
                : t(`（在 ${run.taskCwd} 执行）`, ` (run in ${run.taskCwd})`);
            const cancel = run.taskStatus === 'cancelled'
                ? ''
                : t(`先${cwdHint} supertask cancel --id ${run.taskId}；`, `first${cwdHint}: supertask cancel --id ${run.taskId}; `);
            const owner = run.ownerAlive
                ? t(`owner PID ${run.workerPid} 仍存活，先确认并停止对应进程；`, `owner PID ${run.workerPid} is still alive; confirm and stop it first; `)
                : '';
            warnings.push(t(
                `旧版隔离 run #${run.runId}：${owner}${cancel}确认没有遗留 OpenCode 进程后执行 supertask run abandon --id ${run.runId} --confirm ABANDON`,
                `Legacy quarantined run #${run.runId}: ${owner}${cancel}after confirming no OpenCode process remains, run supertask run abandon --id ${run.runId} --confirm ABANDON`,
            ));
        }
        const ok = opencode.ok
            && plugin.ok
            && database.ok
            && legacyQuarantinedRuns.length === 0
            && gateway.pm2Installed
            && gateway.status === 'online'
            && gateway.ready
            && gatewayEntryPinned
            && gatewayVersionMatchesPackage
            && configuredVersionsMatch
            && cliVersionMatchesPlugin
            && gateway.scopeMatches
            && gateway.logRotationInstalled
            && gateway.startupConfigured !== false
            && dashboard.ok;
        const report = {
            ok,
            packageVersion,
            cliVersionMatchesPlugin,
            configPath: getConfigPath(),
            opencode,
            plugin,
            database,
            legacyQuarantinedRuns,
            gateway,
            dashboard,
            warnings,
        };

        const json = options.json || !process.stdout.isTTY;
        if (json) {
            console.log(JSON.stringify(report, null, 2));
        } else {
            const mark = (value: boolean) => value ? '✓' : '✗';
            console.log(`SuperTask doctor: ${ok ? t('正常', 'healthy') : t('异常', 'unhealthy')}`);
            console.log(`${mark(opencode.ok)} OpenCode ${opencode.version ?? opencode.error ?? t('不可用', 'unavailable')}`);
            console.log(`${mark(plugin.ok)} ${t('OpenCode 插件', 'OpenCode plugin')} ${plugin.spec || plugin.error || t('未配置', 'not configured')}${plugin.cachedVersion ? t(`（缓存 v${plugin.cachedVersion}）`, ` (cached v${plugin.cachedVersion})`) : ''}`);
            console.log(`${mark(database.ok)} ${t('数据库', 'Database')} ${database.path}${t(`（任务 ${database.counts.tasks}，运行中 ${database.runningTasks}）`, ` (tasks ${database.counts.tasks}, running ${database.runningTasks})`)}`);
            console.log(`${mark(gateway.status === 'online' && gateway.ready && gatewayEntryPinned && gatewayVersionMatchesPackage)} Gateway ${gateway.status ?? 'missing'}${gateway.pid ? `，PID ${gateway.pid}` : ''}${gateway.runningVersion ? `，v${gateway.runningVersion}` : ''}${gateway.gatewayEntry ? `，${gateway.gatewayEntry}` : ''}`);
            console.log(`${mark(dashboard.ok)} Dashboard ${dashboard.enabled ? dashboard.url : t('已禁用', 'disabled')}`);
            for (const warning of warnings) console.log(`! ${warning}`);
        }
        if (!ok) process.exitCode = 1;
    }));

program
    .command('install')
    .description(t('用 PM2 安装 Gateway（开机启动、崩溃恢复、日志轮转）', 'install the Gateway with PM2 (startup, crash recovery, log rotation)'))
    .action(async () => {
        try {
            const { install: pm2Install } = await import('../daemon/pm2');
            pm2Install();
        } catch (err) {
            console.error(err instanceof Error ? err.message : String(err));
            process.exit(1);
        }
    });

program
    .command('uninstall')
    .description(t('停止并移除 PM2 Gateway', 'stop and remove the PM2 Gateway'))
    .action(async () => {
        try {
            const { uninstall: pm2Uninstall } = await import('../daemon/pm2');
            pm2Uninstall();
        } catch (err) {
            console.error(err instanceof Error ? err.message : String(err));
            process.exit(1);
        }
    });

program
    .command('upgrade')
    .description(t('更新 OpenCode 插件缓存并重启 Gateway', 'update the OpenCode plugin cache and restart the Gateway'))
    .action(async () => {
        console.log(t('正在更新 opencode-supertask...', 'Updating opencode-supertask...'));
        let installed: { gatewayEntry: string; version: string };
        let previousVersion: string;
        try {
            const { resolveInstalledPlugin } = await import('../daemon/update');
            previousVersion = resolveInstalledPlugin().version;
        } catch (error) {
            console.error(t('无法确认当前 OpenCode 插件版本，已取消升级：', 'Could not determine the current OpenCode plugin version; upgrade cancelled: ')
                + (error instanceof Error ? error.message : String(error)));
            process.exit(1);
        }
        try {
            const { installLatestPlugin } = await import('../daemon/update');
            installed = installLatestPlugin();
        } catch (err) {
            let detail = err instanceof Error ? err.message : String(err);
            try {
                const { installPluginVersion } = await import('../daemon/update');
                installPluginVersion(previousVersion);
            } catch (rollbackError) {
                detail += `; OpenCode 插件回滚失败: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`;
            }
            console.error(detail);
            console.error(t(
                '可人工查询 npm dist-tags.latest，再用 opencode plugin 安装该精确版本。',
                'Try manually: query npm dist-tags.latest, then install that exact version with opencode plugin.',
            ));
            process.exit(1);
        }

        try {
            const { upgrade: pm2Upgrade } = await import('../daemon/pm2');
            const result = pm2Upgrade(installed);
            console.log(t(
                `\nSuperTask 已升级：${result.before ?? 'unknown'} → ${result.after}`,
                `\nSuperTask upgraded: ${result.before ?? 'unknown'} → ${result.after}`,
            ));
            console.log(t('Gateway 已重启。请重启 OpenCode 加载新插件。', 'Gateway restarted. Restart OpenCode to load the new plugin.'));
            try {
                const { updateGlobalCli } = await import('../daemon/update');
                const cli = updateGlobalCli(installed.version);
                if (cli.action === 'updated') {
                    console.log(t(
                        `已使用 ${cli.packageManager} 将全局 CLI 更新到 v${installed.version}。`,
                        `Global CLI updated to v${installed.version} with ${cli.packageManager}.`,
                    ));
                } else if (cli.action === 'not-installed') {
                    console.log(t('未找到全局 CLI；插件和 Gateway 升级已完成。', 'No global CLI installation was found; plugin and Gateway upgrade is complete.'));
                }
            } catch (cliError) {
                console.error(t('插件和 Gateway 已升级，但全局 CLI 未更新：', 'Plugin and Gateway were upgraded, but the global CLI was not: ')
                    + (cliError instanceof Error ? cliError.message : String(cliError)));
                console.error(t(
                    `执行 npm install -g opencode-supertask@${installed.version} 或 bun add -g opencode-supertask@${installed.version}，再运行 supertask doctor。`,
                    `Run npm install -g opencode-supertask@${installed.version} or bun add -g opencode-supertask@${installed.version}, then run supertask doctor.`,
                ));
                process.exit(1);
            }
        } catch (err) {
            let detail = err instanceof Error ? err.message : String(err);
            try {
                if (previousVersion !== installed.version) {
                    const { installPluginVersion } = await import('../daemon/update');
                    installPluginVersion(previousVersion);
                }
            } catch (rollbackError) {
                detail += `; Gateway 已回滚，但 OpenCode 插件回滚失败: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`;
            }
            console.error(t('Gateway 重启失败：', 'Gateway restart failed:'), detail);
            process.exit(1);
        }
    });

program.parse();
