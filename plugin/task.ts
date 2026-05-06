/**
 * OpenCode 任务管理插件
 *
 * [输入]: 任务配置（名称、Agent、提示词等）
 * [输出]: 任务状态、执行结果
 * [定位]: 通过 task_* 工具管理 AI Agent 任务队列
 */

import { type Plugin, tool } from "@opencode-ai/plugin";
import { TaskService } from "@core/services/task.service";
import { closeDb } from "@core/db";

export const TaskPlugin: Plugin = async () => {
    return {
        tool: {
            // 创建任务
            task_add: tool({
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
            task_next: tool({
                description:
                    "获取下一个待执行的任务。按 importance × urgency 降序排列，会自动跳过依赖未完成的任务。",
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
            task_start: tool({
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

            // 完成任务
            task_done: tool({
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
            task_fail: tool({
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
            task_status: tool({
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
            task_retry: tool({
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
        },
    };
};
