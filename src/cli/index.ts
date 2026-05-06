import { Command } from 'commander';
import { TaskService } from '@core/services/task.service';
import { TaskTemplateService } from '@core/services/task-template.service';
import { closeDb } from '@core/db';
import type { TaskStatus, ScheduleType } from '@core/db/schema';

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

const program = new Command();

program
    .name('supertask')
    .description('通用任务管理系统 - AI Agent 任务调度器')
    .version('0.1.0');

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
    .option('-w, --cwd <path>', '(已废弃) 工作目录。系统会自动记录提交任务时的当前目录')
    .action(async (options) => withDb(async () => {
        const submitCwd = process.cwd();
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
            console.log(JSON.stringify({ id: null, message: 'No pending tasks' }));
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
            .option('--interval <ms>', '间隔毫秒（recurring 类型必填）')
            .option('--run-at <ms>', '执行时间戳 ms（delayed 类型必填）')
            .option('-m, --model <model>', '模型')
            .option('-c, --category <category>', '分类', 'general')
            .option('-i, --importance <number>', '重要程度 1-5', '3')
            .option('-u, --urgency <number>', '紧急程度 1-5', '3')
            .option('--max-instances <number>', '最大并发实例数', '1')
            .option('--max-retries <number>', '最大重试次数', '3')
            .option('--retry-backoff <ms>', '退避基础间隔 ms', '30000')
            .action(async (options) => withDb(async () => {
                const tmpl = await TaskTemplateService.create({
                    name: options.name,
                    agent: options.agent,
                    prompt: options.prompt,
                    model: options.model,
                    category: options.category,
                    importance: parseInt(options.importance),
                    urgency: parseInt(options.urgency),
                    scheduleType: options.type as ScheduleType,
                    cronExpr: options.cron,
                    intervalMs: options.interval ? parseInt(options.interval) : null,
                    runAt: options.runAt ? parseInt(options.runAt) : null,
                    maxInstances: parseInt(options.maxInstances),
                    maxRetries: parseInt(options.maxRetries),
                    retryBackoffMs: parseInt(options.retryBackoff),
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

program
    .command('init')
    .description('Initialize SuperTask (create config + run migrations)')
    .action(async () => withDb(async () => {
        const { existsSync, mkdirSync, writeFileSync } = await import('fs');
        const { homedir } = await import('os');
        const { join, dirname } = await import('path');
        const { CONFIG_PATH } = await import('@gateway/config');

        if (!existsSync(CONFIG_PATH)) {
            const dir = dirname(CONFIG_PATH);
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            writeFileSync(CONFIG_PATH, JSON.stringify({
                worker: { maxConcurrency: 2, defaultModel: 'zhipuai-coding-plan/glm-4.7' },
                scheduler: { enabled: true },
            }, null, 2) + '\n');
            console.log(JSON.stringify({ created: CONFIG_PATH }));
        } else {
            console.log(JSON.stringify({ exists: CONFIG_PATH }));
        }

        const { getDb } = await import('@core/db');
        const { migrate } = await import('drizzle-orm/bun-sqlite/migrator');
        const { join: pJoin, dirname: pDirname } = await import('path');
        const { fileURLToPath } = await import('url');
        const __dirname = pDirname(fileURLToPath(import.meta.url));
        migrate(getDb(), { migrationsFolder: pJoin(__dirname, '../../drizzle') });
        console.log(JSON.stringify({ migrated: true }));
    }));

program
    .command('migrate')
    .description('Run database migrations')
    .action(async () => withDb(async () => {
        const { getDb } = await import('@core/db');
        const { migrate } = await import('drizzle-orm/bun-sqlite/migrator');
        const { join, dirname } = await import('path');
        const { fileURLToPath } = await import('url');
        const __dirname = dirname(fileURLToPath(import.meta.url));
        migrate(getDb(), { migrationsFolder: join(__dirname, '../../drizzle') });
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
    .description('Start the Web Dashboard')
    .action(async () => {
        await import('@web/index');
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

program.parse();
