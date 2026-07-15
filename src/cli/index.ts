import { Command } from 'commander';
import { TaskService } from '@core/services/task.service';
import { TaskTemplateService } from '@core/services/task-template.service';
import { DatabaseMaintenanceService } from '@core/services/database-maintenance.service';
import { closeDb } from '@core/db';
import { parseDuration } from '@core/duration';
import type { TaskStatus, ScheduleType } from '@core/db/schema';
import {
    getPackageVersion,
    restartGatewayAfterMaintenance,
    stopGatewayForMaintenance,
} from '../daemon/pm2';

async function withDb<T>(fn: () => Promise<T>): Promise<T> {
    try {
        return await fn();
    } catch (error) {
        console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        closeDb();
        process.exit(1);
    } finally {
        closeDb();
    }
}

interface GatewayMaintenanceReport {
    wasRunning: boolean;
    restarted: boolean;
    keptStopped: boolean;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function runDestructiveDatabaseMaintenance<T extends object>(
    keepStopped: boolean,
    operation: () => T,
): T & { gateway: GatewayMaintenanceReport } {
    const gatewayState = stopGatewayForMaintenance();
    let result: T;
    try {
        result = operation();
    } catch (error) {
        if (gatewayState.wasRunning && !keepStopped) {
            try {
                restartGatewayAfterMaintenance(gatewayState);
            } catch (restartError) {
                throw new Error(
                    `${messageOf(error)}；Gateway 自动恢复也失败：${messageOf(restartError)}`,
                );
            }
        }
        throw error;
    }

    let restarted = false;
    if (gatewayState.wasRunning && !keepStopped) {
        try {
            restarted = restartGatewayAfterMaintenance(gatewayState);
        } catch (error) {
            throw new Error(`数据库维护已完成，但 Gateway 自动重启失败：${messageOf(error)}`);
        }
    }

    return {
        ...result,
        gateway: {
            wasRunning: gatewayState.wasRunning,
            restarted,
            keptStopped: gatewayState.wasRunning && keepStopped,
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
            importance: parseInt(options.importance),
            urgency: parseInt(options.urgency),
            batchId: options.batch,
            dependsOn: options.depends ? parseInt(options.depends) : undefined,
            cwd: submitCwd,
            maxRetries: parseInt(options.maxRetries),
            retryBackoffMs,
            timeoutMs,
        });
        console.log(JSON.stringify({ id: task.id, status: 'created' }, null, 2));
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
    .command('start')
    .description('开始执行任务（标记为 running）')
    .requiredOption('--id <id>', '任务 ID')
    .action(async (options) => withDb(async () => {
        const task = await TaskService.start(parseInt(options.id), { cwd: process.cwd() });
        if (task) {
            console.log(JSON.stringify({ id: task.id, status: task.status }));
        } else {
            console.log(JSON.stringify({ error: 'Task not found' }));
            process.exit(1);
        }
    }));

program
    .command('done')
    .description('完成任务（标记为 done）')
    .requiredOption('--id <id>', '任务 ID')
    .option('-l, --log <log>', '结果日志')
    .action(async (options) => withDb(async () => {
        const task = await TaskService.done(parseInt(options.id), options.log, { cwd: process.cwd() });
        if (task) {
            console.log(JSON.stringify({ id: task.id, status: task.status }));
        } else {
            console.log(JSON.stringify({ error: 'Task not found' }));
            process.exit(1);
        }
    }));

program
    .command('fail')
    .description('标记任务失败')
    .requiredOption('--id <id>', '任务 ID')
    .option('-l, --log <log>', '错误日志')
    .action(async (options) => withDb(async () => {
        const task = await TaskService.fail(parseInt(options.id), options.log, { cwd: process.cwd() });
        if (task) {
            console.log(JSON.stringify({
                id: task.id,
                status: task.status,
                retryCount: task.retryCount,
            }));
        } else {
            console.log(JSON.stringify({ error: 'Task not found' }));
            process.exit(1);
        }
    }));

program
    .command('cancel')
    .description('取消任务')
    .requiredOption('--id <id>', '任务 ID')
    .action(async (options) => withDb(async () => {
        const task = await TaskService.cancel(parseInt(options.id), { cwd: process.cwd() });
        if (task) {
            console.log(JSON.stringify({ id: task.id, status: task.status }));
        } else {
            console.log(JSON.stringify({ error: 'Task not found' }));
            process.exit(1);
        }
    }));

program
    .command('retry')
    .description('重试失败的任务')
    .option('--id <id>', '任务 ID')
    .option('-b, --batch <batchId>', '批次 ID（批量重试）')
    .action(async (options) => withDb(async () => {
        if (options.id) {
            const task = await TaskService.retry(parseInt(options.id), { cwd: process.cwd() });
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
            status: options.status as TaskStatus,
            batchId: options.batch,
            category: options.category,
            cwd: process.cwd(),
            limit: parseInt(options.limit),
        });
        console.log(JSON.stringify(tasks, null, 2));
    }));

program
    .command('get')
    .description('获取单个任务详情')
    .requiredOption('--id <id>', '任务 ID')
    .action(async (options) => withDb(async () => {
        const task = await TaskService.getById(parseInt(options.id), { cwd: process.cwd() });
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
        const deleted = await TaskService.delete(parseInt(options.id), { cwd: process.cwd() });
        console.log(JSON.stringify({ deleted, id: parseInt(options.id) }));
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
            .option('--max-instances <number>', '最大并发实例数', '1')
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
                    importance: parseInt(options.importance),
                    urgency: parseInt(options.urgency),
                    cwd: process.cwd(),
                    batchId: options.batch,
                    scheduleType: options.type as ScheduleType,
                    cronExpr: options.cron,
                    intervalMs,
                    runAt,
                    maxInstances: parseInt(options.maxInstances),
                    maxRetries: parseInt(options.maxRetries),
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
                const tmpl = await TaskTemplateService.enable(parseInt(options.id));
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
                const tmpl = await TaskTemplateService.disable(parseInt(options.id));
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
                const deleted = await TaskTemplateService.delete(parseInt(options.id));
                console.log(JSON.stringify({ deleted, id: parseInt(options.id) }));
            })),
    );

const databaseCommand = new Command('db')
    .description('数据库检查、备份、清空与恢复');

databaseCommand
    .command('check')
    .description('检查数据库完整性、外键和业务表统计')
    .action(async () => withDb(async () => {
        console.log(JSON.stringify(DatabaseMaintenanceService.check(), null, 2));
    }));

databaseCommand
    .command('backup')
    .description('创建经过完整性校验的一致性备份')
    .option('-o, --output <path>', '备份文件路径（默认写入数据库目录）')
    .action(async (options: { output?: string }) => withDb(async () => {
        console.log(JSON.stringify(DatabaseMaintenanceService.backup(options.output), null, 2));
    }));

databaseCommand
    .command('clear')
    .description('备份后事务性清空任务、执行记录和调度模板')
    .option('--confirm <word>', '危险操作确认，必须填写 CLEAR')
    .option('--keep-stopped', '维护结束后不重启原本由 PM2 管理的 Gateway')
    .action(async (options: { confirm?: string; keepStopped?: boolean }) => withDb(async () => {
        if (options.confirm !== 'CLEAR') {
            throw new Error('清空数据库必须显式传入 --confirm CLEAR');
        }
        const result = runDestructiveDatabaseMaintenance(
            options.keepStopped ?? false,
            () => DatabaseMaintenanceService.clear(),
        );
        console.log(JSON.stringify(result, null, 2));
    }));

databaseCommand
    .command('restore')
    .description('自动备份当前库后，从指定备份恢复数据库')
    .requiredOption('--from <path>', '要恢复的 SQLite 备份文件')
    .option('--confirm <word>', '危险操作确认，必须填写 RESTORE')
    .option('--keep-stopped', '维护结束后不重启原本由 PM2 管理的 Gateway')
    .action(async (options: { from: string; confirm?: string; keepStopped?: boolean }) => withDb(async () => {
        if (options.confirm !== 'RESTORE') {
            throw new Error('恢复数据库必须显式传入 --confirm RESTORE');
        }
        const result = runDestructiveDatabaseMaintenance(
            options.keepStopped ?? false,
            () => DatabaseMaintenanceService.restore(options.from),
        );
        console.log(JSON.stringify(result, null, 2));
    }));

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
    .command('install')
    .description('Install Gateway as pm2 service (auto-start on boot, crash recovery)')
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
        try {
            const { installLatestPlugin } = await import('../daemon/update');
            installed = installLatestPlugin();
        } catch (err) {
            console.error(err instanceof Error ? err.message : String(err));
            console.error('Try manually: query npm dist-tags.latest, then install that exact version with opencode plugin.');
            process.exit(1);
        }

        try {
            const { upgrade: pm2Upgrade } = await import('../daemon/pm2');
            const result = pm2Upgrade(installed);
            console.log(`\nSuperTask upgraded: ${result.before ?? 'unknown'} → ${result.after}`);
            console.log('Gateway restarted. Please restart opencode to load the new plugin.');
        } catch (err) {
            console.error('Gateway restart failed:', err instanceof Error ? err.message : String(err));
            process.exit(1);
        }
    });

program.parse();
