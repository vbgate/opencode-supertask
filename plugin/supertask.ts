/**
 * OpenCode SuperTask 任务管理插件
 *
 * [输入]: 任务配置（名称、Agent、提示词等）
 * [输出]: 任务状态、执行结果
 * [定位]: 通过 supertask_* 工具管理 AI Agent 任务队列
 */

import { type Plugin, tool } from "@opencode-ai/plugin";
import { TaskService } from "@core/services/task.service";
import { TaskTemplateService } from "@core/services/task-template.service";
import { getDb, sqlite } from "@core/db";
import { parseDuration } from "@core/duration";
import { ensureGateway, upgrade as pm2Upgrade } from "../src/daemon/pm2";
import { installLatestPlugin } from "../src/daemon/update";

let _initialized = false;

function ensureInit() {
    if (_initialized) return;

    try {
        getDb();
    } catch (err) {
        console.error("[supertask] DB init failed:", err instanceof Error ? err.message : String(err));
        return;
    }

    try {
        const lockRow = sqlite.prepare("SELECT pid, heartbeat_at, ready_at FROM gateway_lock WHERE id = 1").get() as
            | { pid: number; heartbeat_at: number; ready_at: number | null }
            | undefined;

        if (lockRow?.ready_at != null && Date.now() - lockRow.heartbeat_at < 30_000) {
            _initialized = true;
            return;
        }
    } catch {}

    try {
        const gateway = ensureGateway();
        if (!gateway.ok) {
            console.warn("[supertask] Gateway 未自动启动：未安装 pm2。运行 `supertask install` 启用常驻执行，或运行 `supertask gateway` 前台启动。");
        }
    } catch (error) {
        console.error("[supertask] Gateway init failed:", error instanceof Error ? error.message : String(error));
    }

    _initialized = true;
}

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
        async config() {
            ensureInit();
        },

        async "experimental.chat.system.transform"(input, output) {
            output.system.push(SYSTEM_INSTRUCTION);
        },

        tool: {
            // 创建任务
            supertask_add: tool({
                description:
                    "创建新任务到队列。返回任务 ID。任务按 urgency、importance、createdAt、id 的顺序调度。",
                args: {
                    name: tool.schema.string().trim().min(1).describe("任务名称（人类可读）"),
                    agent: tool.schema.string().trim().min(1).describe("执行的 Agent 名称，如 localize-gen, course-gen"),
                    prompt: tool.schema.string().trim().min(1).describe("发送给 Agent 的完整提示词"),
                    model: tool.schema.string().optional().describe("使用的模型，如 gemini-2.5-pro"),
                    category: tool.schema.enum(["translate", "generate", "review", "test", "general"]).optional().describe("任务分类"),
                    importance: tool.schema.number().int().min(1).max(5).optional().describe("重要程度 1-5（5 最重要）"),
                    urgency: tool.schema.number().int().min(1).max(5).optional().describe("紧急程度 1-5（5 最紧急）"),
                    batchId: tool.schema.string().optional().describe("批次 ID，用于分组管理"),
                    dependsOn: tool.schema.number().int().positive().optional().describe("依赖的任务 ID，该任务完成后才会执行"),
                    max_retries: tool.schema.number().int().min(0).max(1000).optional().describe("首次执行之外允许的重试次数，默认 3"),
                    retry_backoff_ms: tool.schema.number().int().min(0).max(86_400_000).optional().describe("重试退避基础间隔 ms，默认 30000"),
                    timeout_ms: tool.schema.number().int().min(1000).max(604_800_000).optional().describe("任务硬超时 ms；未传则使用 Gateway 默认值"),
                    cwd: tool.schema
                        .string()
                        .optional()
                        .describe(
                            "(已废弃) 工作目录。系统会自动记录提交任务时的 opencode run 启动目录。"
                        ),
                },
                async execute(args, context) {
                    try {
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
                            cwd: context.directory,
                            maxRetries: args.max_retries,
                            retryBackoffMs: args.retry_backoff_ms,
                            timeoutMs: args.timeout_ms,
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
                    "获取下一个可执行任务。候选包括 pending 和退避到期且 retryCount <= maxRetries 的 failed 任务，按 urgency、importance、createdAt、id 排序，并跳过依赖未完成的任务。",
                args: {
                    cwd: tool.schema
                        .string()
                        .optional()
                        .describe("项目隔离：传入当前工作目录，只返回该项目的任务"),
                },
                async execute(args, context) {
                    try {
                        const task = await TaskService.next({ cwd: context.directory });
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
                            return JSON.stringify({ id: null, message: "No executable tasks" });
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
                async execute(args, context) {
                    try {
                        const stats = await TaskService.stats({ batchId: args.batchId, cwd: context.directory });
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
                    id: tool.schema.number().int().positive().optional().describe("任务 ID"),
                    batchId: tool.schema.string().optional().describe("批次 ID（批量重试）"),
                    cwd: tool.schema
                        .string()
                        .optional()
                        .describe("项目隔离：传入当前工作目录，只操作该项目的任务"),
                },
                async execute(args, context) {
                    try {
                        if (args.id !== undefined) {
                            const task = await TaskService.retry(args.id, { cwd: context.directory });
                            if (task) {
                                return JSON.stringify({ id: task.id, status: task.status });
                            } else {
                                return JSON.stringify({ error: "Task not found or not failed" });
                            }
                        } else if (args.batchId !== undefined) {
                            const count = await TaskService.retryBatch(args.batchId, { cwd: context.directory });
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
                        .enum(["pending", "running", "done", "failed", "dead_letter", "cancelled"])
                        .optional()
                        .describe("按状态筛选"),
                    limit: tool.schema.number().int().min(1).max(1000).optional().describe("返回数量，默认 20"),
                    cwd: tool.schema
                        .string()
                        .optional()
                        .describe("项目隔离：传入当前工作目录，只返回该项目的任务"),
                },
                async execute(args, context) {
                    try {
                        const tasks = await TaskService.list({
                            status: args.status,
                            cwd: context.directory,
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
                    id: tool.schema.number().int().positive().describe("任务 ID"),
                    cwd: tool.schema
                        .string()
                        .optional()
                        .describe("项目隔离：传入当前工作目录，只返回该项目的任务"),
                },
                async execute(args, context) {
                    try {
                        const task = await TaskService.getById(args.id, { cwd: context.directory });
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
                    name: tool.schema.string().trim().min(1).describe("模板名称"),
                    agent: tool.schema.string().trim().min(1).describe("执行的 Agent 名称"),
                    prompt: tool.schema.string().trim().min(1).describe("发送给 Agent 的完整提示词"),
                    model: tool.schema.string().optional().describe("使用的模型"),
                    category: tool.schema.enum(["translate", "generate", "review", "test", "general"]).optional().describe("任务分类"),
                    importance: tool.schema.number().int().min(1).max(5).optional().describe("重要程度 1-5"),
                    urgency: tool.schema.number().int().min(1).max(5).optional().describe("紧急程度 1-5"),
                    batchId: tool.schema.string().optional().describe("模板生成的任务归属的批次 ID"),
                    schedule: tool.schema
                        .object({
                            type: tool.schema.enum(["cron", "delayed", "recurring"]).describe("调度类型"),
                            cron_expr: tool.schema.string().optional().describe("cron 表达式（cron 类型必填，如 '0 9 * * 1-5'）"),
                            delay: tool.schema.string().optional().describe("延迟时间（delayed 类型必填），友好格式如 '30s' '5min' '1h' '2d'，也支持 ISO 8601 duration 如 'PT30M'"),
                            interval: tool.schema.string().optional().describe("循环间隔（recurring 类型必填），友好格式如 '1h' '30min' '5s'，也支持 ISO 8601 duration 如 'PT1H'"),
                        })
                        .describe("调度配置"),
                    max_instances: tool.schema.number().int().min(1).max(1000).optional().describe("最大并发实例数，默认 1"),
                    max_retries: tool.schema.number().int().min(0).max(1000).optional().describe("克隆给 task 的最大重试次数，默认 3"),
                    retry_backoff_ms: tool.schema.number().int().min(0).max(86_400_000).optional().describe("克隆给 task 的退避基础间隔 ms，默认 30000"),
                    timeout_ms: tool.schema.number().int().min(1000).max(604_800_000).optional().describe("克隆给 task 的硬超时 ms；未传则使用 Gateway 默认值"),
                },
                async execute(args, context) {
                    try {
                        if (!args.schedule) {
                            return JSON.stringify({ error: "schedule is required" });
                        }
                        const scheduleType = args.schedule.type;

                        let cronExpr = args.schedule.cron_expr;
                        let intervalMs: number | null = null;
                        let runAt: number | null = null;

                        if (scheduleType === "delayed" && args.schedule.delay) {
                            const delayMs = parseDuration(args.schedule.delay);
                            if (delayMs === null) {
                                return JSON.stringify({ error: `Invalid delay format: "${args.schedule.delay}". Use formats like "30s", "5min", "1h", "2d"` });
                            }
                            runAt = Date.now() + delayMs;
                        }

                        if (scheduleType === "recurring" && args.schedule.interval) {
                            intervalMs = parseDuration(args.schedule.interval);
                            if (intervalMs === null) {
                                return JSON.stringify({ error: `Invalid interval format: "${args.schedule.interval}". Use formats like "30s", "5min", "1h", "2d"` });
                            }
                        }

                        const tmpl = await TaskTemplateService.create({
                            name: args.name,
                            agent: args.agent,
                            prompt: args.prompt,
                            model: args.model,
                            category: args.category ?? "general",
                            importance: args.importance ?? 3,
                            urgency: args.urgency ?? 3,
                            cwd: context.directory,
                            batchId: args.batchId,
                            scheduleType,
                            cronExpr,
                            intervalMs,
                            runAt,
                            maxInstances: args.max_instances,
                            maxRetries: args.max_retries,
                            retryBackoffMs: args.retry_backoff_ms,
                            timeoutMs: args.timeout_ms,
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

            supertask_upgrade: tool({
                description:
                    "升级 SuperTask 插件。通过 OpenCode 刷新插件缓存，校验新版构建产物后重启 Gateway。当用户说'升级插件'、'更新 supertask'、'upgrade'时使用。",
                args: {},
                async execute() {
                    try {
                        console.log("[supertask] Updating OpenCode plugin cache...");
                        let installed: { gatewayEntry: string; version: string };
                        try {
                            installed = installLatestPlugin();
                        } catch (updateError) {
                            return JSON.stringify({
                                success: false,
                                error: updateError instanceof Error ? updateError.message : String(updateError),
                                hint: "Query npm dist-tags.latest, then install that exact version with opencode plugin.",
                            });
                        }

                        const result = pm2Upgrade(installed);
                        return JSON.stringify({
                            success: true,
                            before: result.before,
                            after: result.after,
                            restarted: result.restarted,
                            message: `SuperTask 已从 ${result.before ?? "unknown"} 升级到 ${result.after}，Gateway 已重启。请重启 opencode 以加载新版插件。`,
                        });
                    } catch (error) {
                        return JSON.stringify({
                            success: false,
                            error: error instanceof Error ? error.message : String(error),
                        });
                    }
                },
            }),
        },
    };
};
