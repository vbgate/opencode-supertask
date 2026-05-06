// 任务表 Schema
// 用于存储 AI Agent 的通用任务队列

import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const tasks = sqliteTable('tasks', {
    id: integer('id').primaryKey({ autoIncrement: true }),

    // 任务配置
    name: text('name').notNull(),                    // 任务名称（人类可读）
    agent: text('agent').notNull(),                  // 主 Agent 名称 (localize-gen, course-gen...)
    model: text('model').default('default'),         // 模型 (claude-4, gemini-2.5-pro...)
    prompt: text('prompt').notNull(),                // 发给主代理的完整提示词
    cwd: text('cwd'),                                // 工作目录（opencode run 启动目录）

    // 分类与优先级
    category: text('category').default('general'),   // 分类：translate/test/generate/review
    importance: integer('importance').default(3),    // 重要程度 1-5 (5最重要)
    urgency: integer('urgency').default(3),          // 紧急程度 1-5 (5最紧急)

    // 任务分组与依赖
    batchId: text('batch_id'),                       // 批次 ID
    dependsOn: integer('depends_on'),                // 依赖的任务 ID (可选)

    // 状态
    status: text('status').default('pending'),       // pending/running/done/failed/cancelled

    // 时间戳
    createdAt: integer('created_at', { mode: 'timestamp' })
        .$defaultFn(() => new Date()),
    startedAt: integer('started_at', { mode: 'timestamp' }),
    finishedAt: integer('finished_at', { mode: 'timestamp' }),

    // 执行结果
    resultLog: text('result_log'),                   // 结果日志
    retryCount: integer('retry_count').default(0),   // 已重试次数
    maxRetries: integer('max_retries').default(3),   // 最大重试次数
});

// 类型导出
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

// 分类枚举
export const TASK_CATEGORIES = [
    'translate',   // 翻译
    'generate',    // 生成
    'review',      // 审核
    'test',        // 测试
    'general',     // 通用
] as const;

// 任务执行记录表
// 一个任务可能执行多次（失败重试等）
export const taskRuns = sqliteTable('task_runs', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    taskId: integer('task_id').notNull().references(() => tasks.id),

    // OpenCode Session
    sessionId: text('session_id'),                   // opencode session ID (ses_xxx)

    // 执行配置
    model: text('model'),                            // 实际使用的模型

    // 状态
    status: text('status').default('running'),       // running/done/failed

    // 时间戳
    startedAt: integer('started_at', { mode: 'timestamp' })
        .$defaultFn(() => new Date()),
    finishedAt: integer('finished_at', { mode: 'timestamp' }),

    // 执行结果
    log: text('log'),                                // 执行日志/错误信息
});

export type TaskRun = typeof taskRuns.$inferSelect;
export type NewTaskRun = typeof taskRuns.$inferInsert;
export type TaskRunStatus = 'running' | 'done' | 'failed';
