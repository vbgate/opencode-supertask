#!/usr/bin/env bun
// CLI 入口
// 用法: bun run src/cli/index.ts <command> [options]

import { Command } from 'commander';
import { TaskService } from '@core/services/task.service';
import { closeDb } from '@core/db';
import type { TaskStatus } from '@core/db/schema';

const program = new Command();

program
    .name('supertask')
    .description('通用任务管理系统 - AI Agent 任务调度器')
    .version('0.1.0');

// task add - 创建任务
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
    .action(async (options) => {
        try {
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
        } catch (error) {
            console.error(JSON.stringify({ error: String(error) }));
            process.exit(1);
        } finally {
            closeDb();
        }
    });

// task next - 获取下一条任务
program
    .command('next')
    .description('获取下一个待执行的任务')
    .action(async () => {
        try {
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
        } catch (error) {
            console.error(JSON.stringify({ error: String(error) }));
            process.exit(1);
        } finally {
            closeDb();
        }
    });

// task start - 开始执行
program
    .command('start')
    .description('开始执行任务（标记为 running）')
    .requiredOption('--id <id>', '任务 ID')
    .action(async (options) => {
        try {
            const task = await TaskService.start(parseInt(options.id), { cwd: process.cwd() });
            if (task) {
                console.log(JSON.stringify({ id: task.id, status: task.status }));
            } else {
                console.log(JSON.stringify({ error: 'Task not found' }));
                process.exit(1);
            }
        } catch (error) {
            console.error(JSON.stringify({ error: String(error) }));
            process.exit(1);
        } finally {
            closeDb();
        }
    });

// task done - 完成任务
program
    .command('done')
    .description('完成任务（标记为 done）')
    .requiredOption('--id <id>', '任务 ID')
    .option('-l, --log <log>', '结果日志')
    .action(async (options) => {
        try {
            const task = await TaskService.done(parseInt(options.id), options.log, { cwd: process.cwd() });
            if (task) {
                console.log(JSON.stringify({ id: task.id, status: task.status }));
            } else {
                console.log(JSON.stringify({ error: 'Task not found' }));
                process.exit(1);
            }
        } catch (error) {
            console.error(JSON.stringify({ error: String(error) }));
            process.exit(1);
        } finally {
            closeDb();
        }
    });

// task fail - 任务失败
program
    .command('fail')
    .description('标记任务失败')
    .requiredOption('--id <id>', '任务 ID')
    .option('-l, --log <log>', '错误日志')
    .action(async (options) => {
        try {
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
        } catch (error) {
            console.error(JSON.stringify({ error: String(error) }));
            process.exit(1);
        } finally {
            closeDb();
        }
    });

// task cancel - 取消任务
program
    .command('cancel')
    .description('取消任务')
    .requiredOption('--id <id>', '任务 ID')
    .action(async (options) => {
        try {
            const task = await TaskService.cancel(parseInt(options.id), { cwd: process.cwd() });
            if (task) {
                console.log(JSON.stringify({ id: task.id, status: task.status }));
            } else {
                console.log(JSON.stringify({ error: 'Task not found' }));
                process.exit(1);
            }
        } catch (error) {
            console.error(JSON.stringify({ error: String(error) }));
            process.exit(1);
        } finally {
            closeDb();
        }
    });

// task retry - 重试任务
program
    .command('retry')
    .description('重试失败的任务')
    .option('--id <id>', '任务 ID')
    .option('-b, --batch <batchId>', '批次 ID（批量重试）')
    .action(async (options) => {
        try {
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
        } catch (error) {
            console.error(JSON.stringify({ error: String(error) }));
            process.exit(1);
        } finally {
            closeDb();
        }
    });

// task status - 查看统计
program
    .command('status')
    .description('查看任务统计')
    .option('-b, --batch <batchId>', '按批次统计')
    .action(async (options) => {
        try {
            const stats = await TaskService.stats({ batchId: options.batch, cwd: process.cwd() });
            console.log(JSON.stringify(stats, null, 2));
        } catch (error) {
            console.error(JSON.stringify({ error: String(error) }));
            process.exit(1);
        } finally {
            closeDb();
        }
    });

// task list - 列出任务
program
    .command('list')
    .description('列出任务')
    .option('-s, --status <status>', '按状态筛选')
    .option('-b, --batch <batchId>', '按批次筛选')
    .option('-c, --category <category>', '按分类筛选')
    .option('-l, --limit <number>', '限制数量', '20')
    .action(async (options) => {
        try {
            const tasks = await TaskService.list({
                status: options.status as TaskStatus,
                batchId: options.batch,
                category: options.category,
                cwd: process.cwd(),
                limit: parseInt(options.limit),
            });
            console.log(JSON.stringify(tasks, null, 2));
        } catch (error) {
            console.error(JSON.stringify({ error: String(error) }));
            process.exit(1);
        } finally {
            closeDb();
        }
    });

// task get - 获取单个任务
program
    .command('get')
    .description('获取单个任务详情')
    .requiredOption('--id <id>', '任务 ID')
    .action(async (options) => {
        try {
            const task = await TaskService.getById(parseInt(options.id), { cwd: process.cwd() });
            if (task) {
                console.log(JSON.stringify(task, null, 2));
            } else {
                console.log(JSON.stringify({ error: 'Task not found' }));
                process.exit(1);
            }
        } catch (error) {
            console.error(JSON.stringify({ error: String(error) }));
            process.exit(1);
        } finally {
            closeDb();
        }
    });

// task delete - 删除任务
program
    .command('delete')
    .description('删除任务')
    .requiredOption('--id <id>', '任务 ID')
    .action(async (options) => {
        try {
            const deleted = await TaskService.delete(parseInt(options.id), { cwd: process.cwd() });
            console.log(JSON.stringify({ deleted, id: parseInt(options.id) }));
        } catch (error) {
            console.error(JSON.stringify({ error: String(error) }));
            process.exit(1);
        } finally {
            closeDb();
        }
    });

program.parse();
