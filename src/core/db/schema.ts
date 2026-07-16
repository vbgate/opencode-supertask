// 任务表 Schema
// 用于存储 AI Agent 的通用任务队列

import { index, sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const tasks = sqliteTable('tasks', {
    id: integer('id').primaryKey({ autoIncrement: true }),

    // 任务配置
    name: text('name').notNull(),
    agent: text('agent').notNull(),
    model: text('model').default('default'),
    prompt: text('prompt').notNull(),
    cwd: text('cwd'),

    // 分类与优先级
    category: text('category').default('general'),
    importance: integer('importance').default(3),
    urgency: integer('urgency').default(3),

    // 任务分组与依赖
    batchId: text('batch_id'),
    dependsOn: integer('depends_on'),

    // 状态
    status: text('status').default('pending'),

    // 时间戳（老字段保持秒级 timestamp）
    createdAt: integer('created_at', { mode: 'timestamp' })
        .$defaultFn(() => new Date()),
    startedAt: integer('started_at', { mode: 'timestamp' }),
    finishedAt: integer('finished_at', { mode: 'timestamp' }),

    // 执行结果
    resultLog: text('result_log'),
    retryCount: integer('retry_count').default(0),
    maxRetries: integer('max_retries').default(3),
    retryBackoffMs: integer('retry_backoff_ms').default(30000),

    // Gateway 扩展字段（毫秒）
    retryAfter: integer('retry_after'),
    timeoutMs: integer('timeout_ms'),
    templateId: integer('template_id'),
    scheduledAt: integer('scheduled_at'),
}, (table) => [
    index('tasks_queue_idx').on(table.status, table.retryAfter, table.urgency, table.importance, table.createdAt, table.id),
    index('tasks_batch_status_idx').on(table.batchId, table.status),
    index('tasks_template_status_idx').on(table.templateId, table.status),
    index('tasks_depends_on_status_idx').on(table.dependsOn, table.status),
    index('tasks_cleanup_idx').on(table.finishedAt, table.id, table.status),
]);

export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'dead_letter' | 'cancelled';

export const TASK_CATEGORIES = [
    'translate',
    'generate',
    'review',
    'test',
    'general',
] as const;

export const taskRuns = sqliteTable('task_runs', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    taskId: integer('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),

    sessionId: text('session_id'),
    model: text('model'),
    status: text('status').default('running'),

    startedAt: integer('started_at', { mode: 'timestamp' })
        .$defaultFn(() => new Date()),
    finishedAt: integer('finished_at', { mode: 'timestamp' }),

    log: text('log'),

    // Gateway 运行时态字段（毫秒）
    lockedAt: integer('locked_at'),
    lockedBy: text('locked_by'),
    heartbeatAt: integer('heartbeat_at'),
    workerPid: integer('worker_pid'),
    childPid: integer('child_pid'),
    launchProtocol: text('launch_protocol'),
}, (table) => [
    index('task_runs_task_started_idx').on(table.taskId, table.startedAt, table.id),
    index('task_runs_status_heartbeat_idx').on(table.status, table.heartbeatAt),
]);

export type TaskRun = typeof taskRuns.$inferSelect;
export type NewTaskRun = typeof taskRuns.$inferInsert;
export type TaskRunStatus = 'running' | 'done' | 'failed';

export const taskTemplates = sqliteTable('task_templates', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    agent: text('agent').notNull(),
    model: text('model').default('default'),
    prompt: text('prompt').notNull(),
    cwd: text('cwd'),
    category: text('category').default('general'),
    importance: integer('importance').default(3),
    urgency: integer('urgency').default(3),
    batchId: text('batch_id'),

    scheduleType: text('schedule_type').notNull(),
    cronExpr: text('cron_expr'),
    intervalMs: integer('interval_ms'),
    runAt: integer('run_at'),

    maxInstances: integer('max_instances').default(1),
    maxRetries: integer('max_retries').default(3),
    retryBackoffMs: integer('retry_backoff_ms').default(30000),
    timeoutMs: integer('timeout_ms'),
    lastRunAt: integer('last_run_at'),
    nextRunAt: integer('next_run_at'),
    enabled: integer('enabled', { mode: 'boolean' }).default(true),

    createdAt: integer('created_at').default(0),
    updatedAt: integer('updated_at').default(0),
}, (table) => [
    index('task_templates_due_idx').on(table.enabled, table.nextRunAt, table.id),
    index('task_templates_retention_idx').on(
        table.scheduleType,
        table.enabled,
        table.lastRunAt,
        table.id,
    ),
]);

export type TaskTemplate = typeof taskTemplates.$inferSelect;
export type NewTaskTemplate = typeof taskTemplates.$inferInsert;
export type ScheduleType = 'cron' | 'delayed' | 'recurring';
