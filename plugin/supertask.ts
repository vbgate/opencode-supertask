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
import { compareSemanticVersions } from "@core/semver";
import { MANAGED_RUN_ENV, MANAGED_RUN_ENV_VALUE } from "@core/launch-protocol";
import { ensureGateway, getPackageVersion, upgrade as pm2Upgrade } from "../src/daemon/pm2";
import {
    installLatestPlugin,
    installPluginVersion,
} from "../src/daemon/update";

let _initialized = false;
let _writeBlockedReason: string | null = null;

function readyGatewayVersion(): { fresh: boolean; version: string | null } {
    const lockRow = sqlite.prepare(
        "SELECT heartbeat_at, ready_at, version FROM gateway_lock WHERE id = 1",
    ).get() as { heartbeat_at: number; ready_at: number | null; version: string | null } | undefined;
    return {
        fresh: lockRow?.ready_at != null && Date.now() - lockRow.heartbeat_at < 30_000,
        version: lockRow?.version ?? null,
    };
}

export function shouldAttemptGatewayReplacement(
    pluginVersion: string,
    gatewayVersion: string | null,
): boolean {
    if (gatewayVersion === null) return true;
    const direction = compareSemanticVersions(pluginVersion, gatewayVersion);
    return direction !== null && direction >= 0;
}

function ensureInit() {
    if (_initialized) return;

    try {
        getDb();
    } catch (err) {
        console.error("[supertask] DB init failed:", err instanceof Error ? err.message : String(err));
        return;
    }

    const expectedVersion = getPackageVersion();
    let initialReady = { fresh: false, version: null as string | null };
    try {
        initialReady = readyGatewayVersion();
        if (initialReady.fresh && initialReady.version === expectedVersion) {
            _initialized = true;
            return;
        }
        if (initialReady.fresh && !shouldAttemptGatewayReplacement(expectedVersion, initialReady.version)) {
            _writeBlockedReason = `Gateway 版本 ${initialReady.version ?? "unknown"} 与当前插件 ${expectedVersion} 不一致；请重启 OpenCode 或显式执行 supertask upgrade`;
            _initialized = true;
            return;
        }
    } catch {}

    try {
        const gateway = ensureGateway();
        if (!gateway.ok) {
            if (initialReady.fresh) {
                _writeBlockedReason = `Gateway 版本 ${initialReady.version ?? "unknown"} 与插件 ${expectedVersion} 不一致，且未安装 pm2 无法安全替换`;
            } else {
                console.warn("[supertask] Gateway 未自动启动：未安装 pm2。运行 `supertask install` 启用常驻执行，或运行 `supertask gateway` 前台启动。");
            }
        } else {
            const current = readyGatewayVersion();
            if (!current.fresh || current.version !== expectedVersion) {
                _writeBlockedReason = `Gateway 就绪版本 ${current.version ?? "unknown"} 与插件 ${expectedVersion} 不一致`;
            }
        }
    } catch (error) {
        _writeBlockedReason = error instanceof Error ? error.message : String(error);
        console.error("[supertask] Gateway init failed:", _writeBlockedReason);
    }

    _initialized = true;
}

function assertRuntimeWritable(): void {
    ensureInit();
    if (_writeBlockedReason) {
        throw new Error(`[supertask] 已阻止队列写入: ${_writeBlockedReason}`);
    }
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

### 批次、并发与依赖

- \`batchId\` 是全局串行执行键：即使任务属于不同项目目录，所有具有相同非空 \`batchId\` 的任务也不会同时执行，Gateway 重启后仍然成立
- 不同 \`batchId\` 或未设置 \`batchId\` 的任务可以并行，但仍受 Gateway 全局并发上限和任务依赖约束
- 把需要互斥执行的任务设置为同一 \`batchId\`；建议使用“项目:用途”等全局唯一名称，不要给彼此独立、希望并行的任务复用同一 \`batchId\`
- \`batchId\` 只保证不并发，不保证不同优先级任务按创建顺序运行；若任务 B 必须等待任务 A 完成，应把 B 的 \`dependsOn\` 设置为 A 的任务 ID
- 向已有批次追加任务前，可用 \`supertask_status\` 的 \`batchId\` 查看当前项目统计，并以返回值 \`globalBatch.activeRunning\` 判断该批次是否已被任一项目占用；\`blockedByOtherProject\` 表示占用来自其他项目

### 调度模板

用 \`supertask_schedule\` 可创建三种定时任务：
- \`cron\`: cron 表达式（如 "0 9 * * 1-5" = 工作日 9 点）
- \`recurring\`: 固定间隔循环（如每 6 小时）
- \`delayed\`: 一次性定时执行
- \`max_instances\` 只限制自动调度产生的活跃实例（排队、运行中、等待重试）；手动“立即运行一次”始终创建任务并加入队列
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
                    "创建新任务到持久队列。跨项目的相同非空 batchId 任务全局严格串行，不同批次可在全局并发上限内并行；dependsOn 用于表达必须完成的先后关系。返回任务 ID。任务按 urgency、importance、createdAt、id 的顺序调度。",
                args: {
                    name: tool.schema.string().trim().min(1).describe("任务名称（人类可读）"),
                    agent: tool.schema.string().trim().min(1).describe("执行的 Agent 名称，如 localize-gen, course-gen"),
                    prompt: tool.schema.string().trim().min(1).describe("发送给 Agent 的完整提示词"),
                    model: tool.schema.string().optional().describe("使用的模型，如 gemini-2.5-pro"),
                    category: tool.schema.enum(["translate", "generate", "review", "test", "general"]).optional().describe("任务分类"),
                    importance: tool.schema.number().int().min(1).max(5).optional().describe("重要程度 1-5（5 最重要）"),
                    urgency: tool.schema.number().int().min(1).max(5).optional().describe("紧急程度 1-5（5 最紧急）"),
                    batchId: tool.schema.string().trim().min(1).optional().describe("全局串行批次 ID：即使属于不同项目，所有相同非空 batchId 的任务也不会同时执行；独立任务请省略，不要传空字符串或复用同一值"),
                    dependsOn: tool.schema.number().int().positive().optional().describe("依赖的任务 ID；需要严格先后顺序时设置，前置任务完成后才会执行"),
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
                        assertRuntimeWritable();
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
                description: "查看当前项目的任务队列统计。传入 batchId 时还返回跨项目的 globalBatch 统计和是否被其他项目占用。",
                args: {
                    batchId: tool.schema.string().trim().min(1).optional().describe("按批次筛选；同名批次在所有项目间全局串行"),
                    cwd: tool.schema
                        .string()
                        .optional()
                        .describe("项目隔离：传入当前工作目录，只统计该项目的任务"),
                },
                async execute(args, context) {
                    try {
                        const project = await TaskService.stats({
                            batchId: args.batchId,
                            cwd: context.directory,
                        });
                        if (args.batchId === undefined) return JSON.stringify(project);

                        const [globalBatch, activeRunning, globalActiveRunning] = await Promise.all([
                            TaskService.stats({ batchId: args.batchId }),
                            TaskService.countRunning({ batchId: args.batchId, cwd: context.directory }),
                            TaskService.countRunning({ batchId: args.batchId }),
                        ]);
                        return JSON.stringify({
                            ...project,
                            activeRunning,
                            globalBatch: {
                                ...globalBatch,
                                activeRunning: globalActiveRunning,
                            },
                            blockedByOtherProject: globalActiveRunning > activeRunning,
                        });
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
                        assertRuntimeWritable();
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
                    batchId: tool.schema.string().trim().min(1).optional().describe("模板生成任务的全局串行批次 ID；跨项目的相同非空 batchId 实例不会同时执行；无批次时请省略"),
                    schedule: tool.schema
                        .object({
                            type: tool.schema.enum(["cron", "delayed", "recurring"]).describe("调度类型"),
                            cron_expr: tool.schema.string().optional().describe("cron 表达式（cron 类型必填，如 '0 9 * * 1-5'）"),
                            delay: tool.schema.string().optional().describe("延迟时间（delayed 类型必填），友好格式如 '30s' '5min' '1h' '2d'，也支持 ISO 8601 duration 如 'PT30M'"),
                            interval: tool.schema.string().optional().describe("循环间隔（recurring 类型必填），友好格式如 '1h' '30min' '5s'，也支持 ISO 8601 duration 如 'PT1H'"),
                        })
                        .describe("调度配置"),
                    max_instances: tool.schema.number().int().min(1).max(1000).optional().describe("自动调度的活跃实例上限，默认 1；活跃实例包含排队、运行中和等待重试，手动立即运行不受此限制"),
                    max_retries: tool.schema.number().int().min(0).max(1000).optional().describe("克隆给 task 的最大重试次数，默认 3"),
                    retry_backoff_ms: tool.schema.number().int().min(0).max(86_400_000).optional().describe("克隆给 task 的退避基础间隔 ms，默认 30000"),
                    timeout_ms: tool.schema.number().int().min(1000).max(604_800_000).optional().describe("克隆给 task 的硬超时 ms；未传则使用 Gateway 默认值"),
                },
                async execute(args, context) {
                    try {
                        assertRuntimeWritable();
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
                    if (process.env[MANAGED_RUN_ENV] === MANAGED_RUN_ENV_VALUE) {
                        return JSON.stringify({
                            success: false,
                            error: "Gateway 管理的队列任务不能升级 SuperTask，否则会终止承载当前任务的 Gateway。",
                            hint: "请从外部终端执行 `supertask upgrade`，或在非队列 OpenCode 会话中调用升级工具。",
                        });
                    }
                    try {
                        console.log("[supertask] Updating OpenCode plugin cache...");
                        const previousVersion = getPackageVersion();
                        let installed: { gatewayEntry: string; version: string };
                        try {
                            installed = installLatestPlugin();
                        } catch (updateError) {
                            let detail = updateError instanceof Error ? updateError.message : String(updateError);
                            try {
                                installPluginVersion(previousVersion);
                            } catch (rollbackError) {
                                detail += `; OpenCode 插件回滚失败: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`;
                            }
                            return JSON.stringify({
                                success: false,
                                error: detail,
                                hint: "Query npm dist-tags.latest, then install that exact version with opencode plugin.",
                            });
                        }
                        let result: ReturnType<typeof pm2Upgrade>;
                        try {
                            result = pm2Upgrade(installed);
                        } catch (upgradeError) {
                            try {
                                if (previousVersion !== installed.version) {
                                    installPluginVersion(previousVersion);
                                }
                            } catch (rollbackError) {
                                const original = upgradeError instanceof Error ? upgradeError.message : String(upgradeError);
                                const rollback = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
                                throw new Error(`${original}; Gateway 已回滚，但 OpenCode 插件回滚失败: ${rollback}`);
                            }
                            throw upgradeError;
                        }
                        return JSON.stringify({
                            success: true,
                            before: result.before,
                            after: result.after,
                            restarted: result.restarted,
                            message: `SuperTask 已从 ${result.before ?? "unknown"} 升级到 ${result.after}，Gateway 已重启。请重启 opencode 以加载新版插件；若使用全局 CLI，请用原包管理器将它更新到 opencode-supertask@${result.after}（npm install -g 或 bun add -g）。`,
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
