/**
 * OpenCode SuperTask 任务管理插件
 *
 * [输入]: 任务配置（名称、Agent、提示词等）
 * [输出]: 任务状态、执行结果
 * [定位]: 通过 supertask_* 工具管理 AI Agent 任务队列
 */

import { type Plugin, type Hooks, tool } from "@opencode-ai/plugin";
import { TaskService } from "@core/services/task.service";
import { TaskTemplateService } from "@core/services/task-template.service";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const RUNNER_PROMPT = readFileSync(join(__dirname, "..", "agents", "supertask-runner.md"), "utf-8");

const SYSTEM_INSTRUCTION = `
## SuperTask 任务队列系统

当前环境已安装 SuperTask 任务队列插件。你可以通过以下工具管理任务：

### 核心工作流

1. **创建任务**: 用 \`supertask_add\` 创建任务到队列，Gateway 会自动调度执行
2. **查看状态**: 用 \`supertask_status\` 查看队列统计，\`supertask_list\` 查看任务列表
3. **重试/管理**: 用 \`supertask_retry\` 重试失败任务，\`supertask_get\` 查看详情

### 何时使用

- 当用户说"帮我创建一个任务"、"把这个做成定时任务"时，使用 \`supertask_add\` 或 \`supertask_schedule\`
- 当用户问"任务进展如何"时，用 \`supertask_status\` 和 \`supertask_list\`
- 当用户说"重试失败的任务"时，用 \`supertask_retry\`

### 调度模板

用 \`supertask_schedule\` 可创建三种定时任务：
- \`cron\`: cron 表达式（如 "0 9 * * 1-5" = 工作日 9 点）
- \`recurring\`: 固定间隔循环（如每 6 小时）
- \`delayed\`: 一次性定时执行
`;

export const SuperTaskPlugin: Plugin = async () => {
    return {
        async config(cfg) {
            cfg.agent = cfg.agent ?? {};
            cfg.agent["supertask-runner"] = {
                description: "SuperTask 任务执行器 - 从任务队列获取任务并派发给子 Agent 执行",
                mode: "all",
                hidden: true,
                prompt: RUNNER_PROMPT,
                temperature: 0.3,
                permission: {
                    bash: "allow",
                },
            };
        },

        async "experimental.chat.system.transform"(input, output) {
            output.system.push(SYSTEM_INSTRUCTION);
        },

        tool: {
            // 创建任务
            supertask_add: tool({
                description:
                    "创建新任务到队列。返回任务 ID。任务将按优先级（importance × urgency）排序执行。",
                args: {
                    name: tool.schema.string().describe("任务名称（人类可读）"),
                    agent: tool.schema.string().describe("执行的 Agent 名称，如 localize-gen, course-gen"),
                    prompt: tool.schema.string().describe("发送给 Agent 的完整提示词"),
                    model: tool.schema.string().optional().describe("使用的模型，如 gemini-2.5-pro"),
                    category: tool.schema.string().optional().describe("任务分类：translate/generate/review/test/general"),
                    importance: tool.schema.number().optional().describe("重要程度 1-5（5 最重要）"),
                    urgency: tool.schema.number().optional().describe("紧急程度 1-5（5 最紧急）"),
                    batchId: tool.schema.string().optional().describe("批次 ID，用于分组管理"),
                    dependsOn: tool.schema.number().optional().describe("依赖的任务 ID，该任务完成后才会执行"),
                    cwd: tool.schema
                        .string()
                        .optional()
                        .describe(
                            "(已废弃) 工作目录。系统会自动记录提交任务时的 opencode run 启动目录。"
                        ),
                },
                async execute(args) {
                    try {
                        // 记录“提交任务时”的工作目录（即当前 opencode 进程的启动目录）
                        // 不依赖/不要求调用方传入 cwd，避免 worker 与提交端目录不一致导致执行错目录。
                        const submitCwd = process.cwd();

                        const task = await TaskService.add({
                            name: args.name,
                            agent: args.agent,
                            prompt: args.prompt,
                            model: args.model,
                            category: args.category ?? "general",
                            importance: args.importance ?? 3,
                            urgency: args.urgency ?? 3,
                            batchId: args.batchId,
                            dependsOn: args.dependsOn,
                            cwd: submitCwd,
                        });
                        return JSON.stringify({ id: task.id, status: "created" });
                    } catch (error) {
                        return JSON.stringify({
                            error: error instanceof Error ? error.message : String(error),
                        });
                    }
                },
            }),

            // 获取下一条任务
            supertask_next: tool({
                description:
                    "获取下一个待执行的任务。优先处理可重试的失败任务（retryCount < maxRetries），再处理 pending 任务，均按创建时间升序排列，会自动跳过依赖未完成的任务。",
                args: {
                    cwd: tool.schema
                        .string()
                        .optional()
                        .describe("项目隔离：传入当前工作目录，只返回该项目的任务"),
                },
                async execute(args) {
                    try {
                        const scopeCwd = args.cwd ?? process.cwd();
                        const task = await TaskService.next({ cwd: scopeCwd });
                        if (task) {
                            return JSON.stringify({
                                id: task.id,
                                name: task.name,
                                agent: task.agent,
                                model: task.model,
                                prompt: task.prompt,
                                cwd: task.cwd,
                                category: task.category,
                                importance: task.importance,
                                urgency: task.urgency,
                            });
                        } else {
                            return JSON.stringify({ id: null, message: "No pending tasks" });
                        }
                    } catch (error) {
                        return JSON.stringify({
                            error: error instanceof Error ? error.message : String(error),
                        });
                    }
                },
            }),

            // 开始执行任务
            supertask_start: tool({
                description: "标记任务为正在执行（running）。记录开始时间。",
                args: {
                    id: tool.schema.number().describe("任务 ID"),
                    cwd: tool.schema
                        .string()
                        .optional()
                        .describe("项目隔离：传入当前工作目录，只操作该项目的任务"),
                },
                async execute(args) {
                    try {
                        const scopeCwd = args.cwd ?? process.cwd();
                        const task = await TaskService.start(args.id, { cwd: scopeCwd });
                        if (task) return JSON.stringify({ id: task.id, status: task.status });

                        // start() 只会把 pending -> running。
                        // 当返回 null 时，需要区分：任务不存在 vs 任务存在但状态不允许 start。
                        const existing = await TaskService.getById(args.id, { cwd: scopeCwd });
                        if (!existing) return JSON.stringify({ error: "Task not found" });

                        return JSON.stringify({
                            error: "Task status does not allow start",
                            id: existing.id,
                            status: existing.status,
                            message: `Only pending tasks can be started; current status is '${existing.status}'.`,
                        });
                    } catch (error) {
                        return JSON.stringify({
                            error: error instanceof Error ? error.message : String(error),
                        });
                    }
                },
            }),

            // 完成任务
            supertask_done: tool({
                description: "标记任务完成（done）。记录结束时间和结果日志。",
                args: {
                    id: tool.schema.number().describe("任务 ID"),
                    log: tool.schema.string().optional().describe("执行结果日志"),
                    cwd: tool.schema
                        .string()
                        .optional()
                        .describe("项目隔离：传入当前工作目录，只操作该项目的任务"),
                },
                async execute(args) {
                    try {
                        const scopeCwd = args.cwd ?? process.cwd();
                        const task = await TaskService.done(args.id, args.log, { cwd: scopeCwd });
                        if (task) {
                            return JSON.stringify({ id: task.id, status: task.status });
                        } else {
                            return JSON.stringify({ error: "Task not found" });
                        }
                    } catch (error) {
                        return JSON.stringify({
                            error: error instanceof Error ? error.message : String(error),
                        });
                    }
                },
            }),

            // 任务失败
            supertask_fail: tool({
                description: "标记任务失败（failed）。记录错误日志，自动增加重试计数。",
                args: {
                    id: tool.schema.number().describe("任务 ID"),
                    log: tool.schema.string().optional().describe("错误日志"),
                    cwd: tool.schema
                        .string()
                        .optional()
                        .describe("项目隔离：传入当前工作目录，只操作该项目的任务"),
                },
                async execute(args) {
                    try {
                        const scopeCwd = args.cwd ?? process.cwd();
                        const task = await TaskService.fail(args.id, args.log, { cwd: scopeCwd });
                        if (task) {
                            return JSON.stringify({
                                id: task.id,
                                status: task.status,
                                retryCount: task.retryCount,
                            });
                        } else {
                            return JSON.stringify({ error: "Task not found" });
                        }
                    } catch (error) {
                        return JSON.stringify({
                            error: error instanceof Error ? error.message : String(error),
                        });
                    }
                },
            }),

            // 查看统计
            supertask_status: tool({
                description: "查看任务队列统计。可按批次筛选。",
                args: {
                    batchId: tool.schema.string().optional().describe("按批次筛选"),
                    cwd: tool.schema
                        .string()
                        .optional()
                        .describe("项目隔离：传入当前工作目录，只统计该项目的任务"),
                },
                async execute(args) {
                    try {
                        const scopeCwd = args.cwd ?? process.cwd();
                        const stats = await TaskService.stats({ batchId: args.batchId, cwd: scopeCwd });
                        return JSON.stringify(stats);
                    } catch (error) {
                        return JSON.stringify({
                            error: error instanceof Error ? error.message : String(error),
                        });
                    }
                },
            }),

            // 重试失败任务
            supertask_retry: tool({
                description:
                    "重试失败的任务。将 failed 状态重置为 pending，自动清除开始/结束时间。",
                args: {
                    id: tool.schema.number().optional().describe("任务 ID"),
                    batchId: tool.schema.string().optional().describe("批次 ID（批量重试）"),
                    cwd: tool.schema
                        .string()
                        .optional()
                        .describe("项目隔离：传入当前工作目录，只操作该项目的任务"),
                },
                async execute(args) {
                    try {
                        const scopeCwd = args.cwd ?? process.cwd();
                        if (args.id !== undefined) {
                            const task = await TaskService.retry(args.id, { cwd: scopeCwd });
                            if (task) {
                                return JSON.stringify({ id: task.id, status: task.status });
                            } else {
                                return JSON.stringify({ error: "Task not found or not failed" });
                            }
                        } else if (args.batchId !== undefined) {
                            const count = await TaskService.retryBatch(args.batchId, { cwd: scopeCwd });
                            return JSON.stringify({ retried: count, batchId: args.batchId });
                        } else {
                            return JSON.stringify({ error: "Please specify id or batchId" });
                        }
                    } catch (error) {
                        return JSON.stringify({
                            error: error instanceof Error ? error.message : String(error),
                        });
                    }
                },
            }),

            // 列出最近任务
            supertask_list: tool({
                description: "列出最近的任务。支持按状态筛选，按创建时间倒序。",
                args: {
                    status: tool.schema
                        .string()
                        .optional()
                        .describe("按状态筛选：pending/running/done/failed/cancelled"),
                    limit: tool.schema.number().optional().describe("返回数量，默认 20"),
                    cwd: tool.schema
                        .string()
                        .optional()
                        .describe("项目隔离：传入当前工作目录，只返回该项目的任务"),
                },
                async execute(args) {
                    try {
                        const scopeCwd = args.cwd ?? process.cwd();
                        const tasks = await TaskService.list({
                            status: args.status as import("@core/db/schema").TaskStatus | undefined,
                            cwd: scopeCwd,
                            limit: args.limit ?? 20,
                        });
                        return JSON.stringify(tasks);
                    } catch (error) {
                        return JSON.stringify({
                            error: error instanceof Error ? error.message : String(error),
                        });
                    }
                },
            }),

            // 获取指定任务详情
            supertask_get: tool({
                description: "获取指定 ID 的任务详情。",
                args: {
                    id: tool.schema.number().describe("任务 ID"),
                    cwd: tool.schema
                        .string()
                        .optional()
                        .describe("项目隔离：传入当前工作目录，只返回该项目的任务"),
                },
                async execute(args) {
                    try {
                        const scopeCwd = args.cwd ?? process.cwd();
                        const task = await TaskService.getById(args.id, { cwd: scopeCwd });
                        if (task) {
                            return JSON.stringify({
                                id: task.id,
                                name: task.name,
                                agent: task.agent,
                                model: task.model,
                                prompt: task.prompt,
                                cwd: task.cwd,
                                category: task.category,
                                status: task.status,
                            });
                        } else {
                            return JSON.stringify({ error: "Task not found" });
                        }
                    } catch (error) {
                        return JSON.stringify({
                            error: error instanceof Error ? error.message : String(error),
                        });
                    }
                },
            }),

            // 创建调度模板
            supertask_schedule: tool({
                description:
                    "创建调度模板，用于定时/延迟/循环执行任务。支持 cron 表达式、一次性延迟和固定间隔循环。Gateway 会按模板自动生成任务到队列。",
                args: {
                    name: tool.schema.string().describe("模板名称"),
                    agent: tool.schema.string().describe("执行的 Agent 名称"),
                    prompt: tool.schema.string().describe("发送给 Agent 的完整提示词"),
                    model: tool.schema.string().optional().describe("使用的模型"),
                    category: tool.schema.string().optional().describe("任务分类：translate/generate/review/test/general"),
                    importance: tool.schema.number().optional().describe("重要程度 1-5"),
                    urgency: tool.schema.number().optional().describe("紧急程度 1-5"),
                    batchId: tool.schema.string().optional().describe("模板生成的任务归属的批次 ID"),
                    schedule: tool.schema
                        .object({
                            type: tool.schema.enum(["cron", "delayed", "recurring"]).describe("调度类型"),
                            cron_expr: tool.schema.string().optional().describe("cron 表达式（cron 类型必填，如 '0 9 * * 1-5'）"),
                            run_at: tool.schema.number().optional().describe("执行时间戳 ms（delayed 类型必填）"),
                            interval_ms: tool.schema.number().optional().describe("间隔毫秒（recurring 类型必填）"),
                        })
                        .describe("调度配置"),
                    max_instances: tool.schema.number().optional().describe("最大并发实例数，默认 1"),
                    max_retries: tool.schema.number().optional().describe("克隆给 task 的最大重试次数，默认 3"),
                    retry_backoff_ms: tool.schema.number().optional().describe("克隆给 task 的退避基础间隔 ms，默认 30000"),
                },
                async execute(args) {
                    try {
                        if (!args.schedule) {
                            return JSON.stringify({ error: "schedule is required" });
                        }
                        const scheduleType = args.schedule.type as import("@core/db/schema").ScheduleType;
                        const tmpl = await TaskTemplateService.create({
                            name: args.name,
                            agent: args.agent,
                            prompt: args.prompt,
                            model: args.model,
                            category: args.category ?? "general",
                            importance: args.importance ?? 3,
                            urgency: args.urgency ?? 3,
                            scheduleType,
                            cronExpr: args.schedule.cron_expr,
                            intervalMs: args.schedule.interval_ms,
                            runAt: args.schedule.run_at,
                            maxInstances: args.max_instances,
                            maxRetries: args.max_retries,
                            retryBackoffMs: args.retry_backoff_ms,
                        });
                        return JSON.stringify({
                            id: tmpl.id,
                            status: "created",
                            scheduleType: tmpl.scheduleType,
                            nextRunAt: tmpl.nextRunAt,
                            enabled: tmpl.enabled,
                        });
                    } catch (error) {
                        return JSON.stringify({
                            error: error instanceof Error ? error.message : String(error),
                        });
                    }
                },
            }),
        },
    };
};
