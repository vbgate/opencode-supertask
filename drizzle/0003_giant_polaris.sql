CREATE TABLE `task_templates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`agent` text NOT NULL,
	`model` text DEFAULT 'default',
	`prompt` text NOT NULL,
	`cwd` text,
	`category` text DEFAULT 'general',
	`importance` integer DEFAULT 3,
	`urgency` integer DEFAULT 3,
	`schedule_type` text NOT NULL,
	`cron_expr` text,
	`interval_ms` integer,
	`run_at` integer,
	`max_instances` integer DEFAULT 1,
	`max_retries` integer DEFAULT 3,
	`retry_backoff_ms` integer DEFAULT 30000,
	`last_run_at` integer,
	`next_run_at` integer,
	`enabled` integer DEFAULT true,
	`created_at` integer,
	`updated_at` integer
);
--> statement-breakpoint
ALTER TABLE `task_runs` ADD `locked_at` integer;--> statement-breakpoint
ALTER TABLE `task_runs` ADD `locked_by` text;--> statement-breakpoint
ALTER TABLE `task_runs` ADD `heartbeat_at` integer;--> statement-breakpoint
ALTER TABLE `task_runs` ADD `worker_pid` integer;--> statement-breakpoint
ALTER TABLE `task_runs` ADD `child_pid` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `retry_after` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `timeout_ms` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `template_id` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `scheduled_at` integer;