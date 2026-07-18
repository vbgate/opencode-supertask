import { Command } from 'commander';
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
    .description('通用任务管理系统 - AI Agent 任务调度器')
    .version(getPackageVersion());

program
    .command('add')
    .description('创建新任务')
    .requiredOption('-n, --name <name>', '任务名称')
    .requiredOption('-a, --agent <agent>', '主 Agent 名称')
    .requiredOption('-p, --prompt <prompt>', '提示词')
    .option('-m, --model <model>', '模型')
    .option('-c, --category <category>', '分类', 'general')
    .option('-i, --importance <number>', '重要程度 (1-5)', '3')
    .option('-u, --urgency <number>', '紧急程度 (1-5)', '3')
    .option('-b, --batch <batchId>', '批次 ID')
    .option('-d, --depends <taskId>', '依赖的任务 ID')
    .option('--max-retries <number>', '首次执行之外允许的重试次数', '3')
    .option('--retry-backoff <duration>', '重试退避基础间隔，如 30s / 5min', '30s')
    .option('--timeout <duration>', '任务硬超时，如 30min / 2h')
    .option('-w, --cwd <path>', '(已废弃) 工作目录。系统会自动记录提交任务时的当前目录')
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
    .description('修改当前项目中尚未完成的任务')
    .requiredOption('--id <id>', '任务 ID')
    .option('-n, --name <name>', '任务名称')
    .option('-a, --agent <agent>', 'Agent 名称')
    .option('-m, --model <model>', '模型')
    .option('-p, --prompt <prompt>', '提示词')
    .option('-c, --category <category>', '分类')
    .option('-i, --importance <number>', '重要程度 (1-5)')
    .option('-u, --urgency <number>', '紧急程度 (1-5)')
    .option('-b, --batch <batchId>', '批次 ID')
    .option('--clear-batch', '清空批次 ID')
    .option('--max-retries <number>', '首次执行之外允许的重试次数')
    .option('--retry-backoff <duration>', '重试退避基础间隔，如 30s / 5min')
    .option('--timeout <duration>', '任务硬超时，如 30min / 2h')
    .option('--clear-timeout', '清空任务级超时，改用 Gateway 默认值')
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
    .description('获取下一个待执行的任务')
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
    .description('取消任务')
    .requiredOption('--id <id>', '任务 ID')
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
    .description('管理隔离的执行记录');

runCommand
    .command('abandon')
    .description('人工关闭已确认不存在遗留进程的旧版无 PID 隔离记录')
    .requiredOption('--id <id>', '执行记录 run ID')
    .option('--confirm <word>', '危险操作确认，必须填写 ABANDON')
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
    .description('重试失败的任务')
    .option('--id <id>', '任务 ID')
    .option('-b, --batch <batchId>', '批次 ID（批量重试）')
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
    .description('查看任务统计')
    .option('-b, --batch <batchId>', '按批次统计')
    .action(async (options) => withDb(async () => {
        const stats = await TaskService.stats({ batchId: options.batch, cwd: process.cwd() });
        console.log(JSON.stringify(stats, null, 2));
    }));

program
    .command('list')
    .description('列出任务')
    .option('-s, --status <status>', '按状态筛选')
    .option('-b, --batch <batchId>', '按批次筛选')
    .option('-c, --category <category>', '按分类筛选')
    .option('-l, --limit <number>', '限制数量', '20')
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
    .description('获取单个任务详情')
    .requiredOption('--id <id>', '任务 ID')
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
    .description('删除任务')
    .requiredOption('--id <id>', '任务 ID')
    .action(async (options) => withDb(async () => {
        const id = parsePositiveInteger(options.id, 'id');
        const deleted = await TaskService.delete(id, { cwd: process.cwd() });
        console.log(JSON.stringify({ deleted, id }));
    }));

program
    .command('template')
    .description('管理任务调度模板')
    .addCommand(
        new Command('add')
            .description('创建调度模板')
            .requiredOption('-n, --name <name>', '模板名称')
            .requiredOption('-a, --agent <agent>', 'Agent 名称')
            .requiredOption('-p, --prompt <prompt>', '提示词')
            .requiredOption('-t, --type <type>', '调度类型：cron/delayed/recurring')
            .option('--cron <expr>', 'cron 表达式（cron 类型必填）')
            .option('--delay <duration>', '延迟时间（delayed 类型必填），如 30s / 5min / 1h / 2d')
            .option('--interval <duration>', '循环间隔（recurring 类型必填），如 1h / 30min / 5s')
            .option('-m, --model <model>', '模型')
            .option('-c, --category <category>', '分类', 'general')
            .option('-i, --importance <number>', '重要程度 1-5', '3')
            .option('-u, --urgency <number>', '紧急程度 1-5', '3')
            .option('-b, --batch <batchId>', '模板生成任务的批次 ID')
            .option('--max-instances <number>', '自动调度活跃实例上限（手动触发不受限）', '1')
            .option('--max-retries <number>', '最大重试次数', '3')
            .option('--retry-backoff <duration>', '退避基础间隔，如 30s / 5min', '30s')
            .option('--timeout <duration>', '每次任务硬超时，如 30min / 2h')
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
            .description('列出调度模板')
            .action(async () => withDb(async () => {
                const templates = await TaskTemplateService.list();
                console.log(JSON.stringify(templates, null, 2));
            })),
    )
    .addCommand(
        new Command('enable')
            .description('启用模板')
            .requiredOption('--id <id>', '模板 ID')
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
            .description('禁用模板')
            .requiredOption('--id <id>', '模板 ID')
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
            .description('删除模板')
            .requiredOption('--id <id>', '模板 ID')
            .action(async (options) => withDb(async () => {
                const id = parsePositiveInteger(options.id, 'id');
                const deleted = await TaskTemplateService.delete(id);
                console.log(JSON.stringify({ deleted, id }));
            })),
    );

const databaseCommand = new Command('db')
    .description('数据库检查、备份、清空与恢复');

databaseCommand
    .command('check')
    .description('检查数据库完整性、外键和业务表统计')
    .option('--json', '强制输出 JSON（非交互调用默认已输出 JSON）')
    .action(async (options: { json?: boolean }) => withDb(async () => {
        const result = DatabaseMaintenanceService.check();
        console.log(renderDatabaseResult('check', result, { forceJson: options.json }));
        if (!result.ok) process.exitCode = 1;
    }, (error) => renderDatabaseError(error, { forceJson: options.json })));

databaseCommand
    .command('backup')
    .description('创建经过完整性校验的一致性备份')
    .option('-o, --output <path>', '备份文件路径（默认写入数据库目录）')
    .option('--json', '强制输出 JSON（非交互调用默认已输出 JSON）')
    .action(async (options: { output?: string; json?: boolean }) => withDb(async () => {
        const result = DatabaseMaintenanceService.backup(options.output);
        console.log(renderDatabaseResult('backup', result, { forceJson: options.json }));
    }, (error) => renderDatabaseError(error, { forceJson: options.json })));

databaseCommand
    .command('clear')
    .description('备份后事务性清空任务、执行记录和调度模板')
    .option('--confirm <word>', '危险操作确认，必须填写 CLEAR')
    .option('--keep-stopped', '维护结束后不重启原本由 PM2 管理的 Gateway')
    .option('--json', '强制输出 JSON（非交互调用默认已输出 JSON）')
    .action(async (options: { confirm?: string; keepStopped?: boolean; json?: boolean }) => withDb(async () => {
        if (options.confirm !== 'CLEAR') {
            throw new Error('清空数据库必须显式传入 --confirm CLEAR');
        }
        const result = runDestructiveDatabaseMaintenance(
            options.keepStopped ?? false,
            () => DatabaseMaintenanceService.clear(),
        );
        console.log(renderDatabaseResult('clear', result, { forceJson: options.json }));
    }, (error) => renderDatabaseError(error, { forceJson: options.json })));

databaseCommand
    .command('restore')
    .description('自动备份当前库后，从指定备份恢复数据库')
    .requiredOption('--from <path>', '要恢复的 SQLite 备份文件')
    .option('--confirm <word>', '危险操作确认，必须填写 RESTORE')
    .option('--keep-stopped', '维护结束后不重启原本由 PM2 管理的 Gateway')
    .option('--json', '强制输出 JSON（非交互调用默认已输出 JSON）')
    .action(async (options: { from: string; confirm?: string; keepStopped?: boolean; json?: boolean }) => withDb(async () => {
        if (options.confirm !== 'RESTORE') {
            throw new Error('恢复数据库必须显式传入 --confirm RESTORE');
        }
        const result = runDestructiveDatabaseMaintenance(
            options.keepStopped ?? false,
            () => DatabaseMaintenanceService.restore(options.from),
        );
        console.log(renderDatabaseResult('restore', result, { forceJson: options.json }));
    }, (error) => renderDatabaseError(error, { forceJson: options.json })));

program.addCommand(databaseCommand);

program
    .command('init')
    .description('Initialize SuperTask (create config + run migrations)')
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
    .description('Run database migrations')
    .action(async () => withDb(async () => {
        const { getDb } = await import('@core/db');
        getDb();
        console.log(JSON.stringify({ migrated: true }));
    }));

program
    .command('gateway')
    .description('Start the Gateway process (foreground)')
    .action(async () => {
        const { main } = await import('@gateway/index');
        await main();
    });

program
    .command('ui')
    .description('Open Web Dashboard (embedded in Gateway)')
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
    .description('Show current configuration')
    .action(async () => {
        const { loadConfig } = await import('@gateway/config');
        const cfg = loadConfig();
        console.log(JSON.stringify(cfg, null, 2));
    });

program
    .command('doctor')
    .description('检查 OpenCode、数据库、Gateway、Dashboard 和日志轮转')
    .option('--json', '强制输出 JSON')
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
                : (opencodeResult.error?.message || opencodeResult.stderr.trim() || `退出码 ${opencodeResult.status}`),
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
        if (!plugin.ok && plugin.error) {
            warnings.push(plugin.error);
        }
        if (plugin.version !== null && plugin.version !== packageVersion) {
            warnings.push(`当前 CLI v${packageVersion} 与 OpenCode 插件 v${plugin.version} 不一致；请用原包管理器全局安装 opencode-supertask@${plugin.version}（npm install -g 或 bun add -g）`);
        }
        if (!gatewayEntryPinned) {
            warnings.push(`PM2 Gateway 仍从浮动缓存路径启动：${gateway.gatewayEntry}`);
        }
        if (gateway.processFound && gateway.gatewayPackageVersion === null) {
            warnings.push(`无法从 PM2 Gateway 入口确认 opencode-supertask 包版本：${gateway.gatewayEntry ?? 'unknown'}`);
        } else if (gateway.processFound && !gatewayVersionMatchesPackage) {
            warnings.push(`Gateway ready 锁版本 ${gateway.runningVersion ?? 'unknown'} 与入口包版本 ${gateway.gatewayPackageVersion ?? 'unknown'} 不一致`);
        }
        if (plugin.version !== null && gateway.gatewayPackageVersion !== null
            && plugin.version !== gateway.gatewayPackageVersion) {
            warnings.push(`OpenCode 插件 v${plugin.version} 与 PM2 Gateway v${gateway.gatewayPackageVersion} 不一致；执行 supertask upgrade`);
        }
        if (gateway.pm2Installed && !gateway.logRotationInstalled) {
            warnings.push('未检测到 pm2-logrotate；长期运行前建议安装并限制日志保留量');
        }
        if (gateway.startupConfigured === false) {
            warnings.push(process.platform === 'linux'
                ? '未检测到已启用且包含可恢复 PM2 dump 的 systemd 自启服务'
                : '未检测到正在运行且包含可恢复 PM2 dump 的 macOS LaunchAgent');
        }
        if (gateway.processFound && !gateway.scopeMatches) {
            warnings.push('当前 CLI/OpenCode 与 PM2 Gateway 的数据库、配置或 OpenCode 可执行文件作用域不一致');
        }
        for (const run of legacyQuarantinedRuns) {
            const cwdHint = run.taskCwd == null ? '（旧任务没有 cwd，请先在 Dashboard 取消）' : `（在 ${run.taskCwd} 执行）`;
            const cancel = run.taskStatus === 'cancelled'
                ? ''
                : `先${cwdHint} supertask cancel --id ${run.taskId}；`;
            const owner = run.ownerAlive
                ? `owner PID ${run.workerPid} 仍存活，先确认并停止对应进程；`
                : '';
            warnings.push(
                `旧版隔离 run #${run.runId}：${owner}${cancel}确认没有遗留 OpenCode 进程后执行 supertask run abandon --id ${run.runId} --confirm ABANDON`,
            );
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
            && gateway.scopeMatches
            && gateway.logRotationInstalled
            && gateway.startupConfigured !== false
            && dashboard.ok;
        const report = {
            ok,
            packageVersion,
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
            console.log(`SuperTask doctor: ${ok ? '正常' : '异常'}`);
            console.log(`${mark(opencode.ok)} OpenCode ${opencode.version ?? opencode.error ?? '不可用'}`);
            console.log(`${mark(plugin.ok)} OpenCode 插件 ${plugin.spec || plugin.error || '未配置'}${plugin.cachedVersion ? `（缓存 v${plugin.cachedVersion}）` : ''}`);
            console.log(`${mark(database.ok)} 数据库 ${database.path}（任务 ${database.counts.tasks}，运行中 ${database.runningTasks}）`);
            console.log(`${mark(gateway.status === 'online' && gateway.ready && gatewayEntryPinned && gatewayVersionMatchesPackage)} Gateway ${gateway.status ?? 'missing'}${gateway.pid ? `，PID ${gateway.pid}` : ''}${gateway.runningVersion ? `，v${gateway.runningVersion}` : ''}${gateway.gatewayEntry ? `，${gateway.gatewayEntry}` : ''}`);
            console.log(`${mark(dashboard.ok)} Dashboard ${dashboard.enabled ? dashboard.url : '已禁用'}`);
            for (const warning of warnings) console.log(`! ${warning}`);
        }
        if (!ok) process.exitCode = 1;
    }));

program
    .command('install')
    .description('Install Gateway as pm2 service (auto-start, crash recovery, log rotation)')
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
    .description('Stop and remove Gateway pm2 service')
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
    .description('Update OpenCode plugin cache and restart Gateway')
    .action(async () => {
        console.log('Updating opencode-supertask...');
        let installed: { gatewayEntry: string; version: string };
        let previousVersion: string;
        try {
            const { resolveInstalledPlugin } = await import('../daemon/update');
            previousVersion = resolveInstalledPlugin().version;
        } catch (error) {
            console.error(`无法确认当前 OpenCode 插件版本，已取消升级: ${error instanceof Error ? error.message : String(error)}`);
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
            console.error('Try manually: query npm dist-tags.latest, then install that exact version with opencode plugin.');
            process.exit(1);
        }

        try {
            const { upgrade: pm2Upgrade } = await import('../daemon/pm2');
            const result = pm2Upgrade(installed);
            console.log(`\nSuperTask upgraded: ${result.before ?? 'unknown'} → ${result.after}`);
            console.log('Gateway restarted. Please restart opencode to load the new plugin.');
            if (getPackageVersion() !== installed.version) {
                console.log(`Global CLI remains v${getPackageVersion()}. Update it with your original package manager to opencode-supertask@${installed.version} (npm install -g or bun add -g).`);
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
            console.error('Gateway restart failed:', detail);
            process.exit(1);
        }
    });

program.parse();
