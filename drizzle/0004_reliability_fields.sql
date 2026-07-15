PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_task_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` integer NOT NULL,
	`session_id` text,
	`model` text,
	`status` text DEFAULT 'running',
	`started_at` integer,
	`finished_at` integer,
	`log` text,
	`locked_at` integer,
	`locked_by` text,
	`heartbeat_at` integer,
	`worker_pid` integer,
	`child_pid` integer,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_task_runs`("id", "task_id", "session_id", "model", "status", "started_at", "finished_at", "log", "locked_at", "locked_by", "heartbeat_at", "worker_pid", "child_pid") SELECT "id", "task_id", "session_id", "model", "status", "started_at", "finished_at", "log", "locked_at", "locked_by", "heartbeat_at", "worker_pid", "child_pid" FROM `task_runs`;--> statement-breakpoint
DROP TABLE `task_runs`;--> statement-breakpoint
ALTER TABLE `__new_task_runs` RENAME TO `task_runs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `task_runs_task_started_idx` ON `task_runs` (`task_id`,`started_at`,`id`);--> statement-breakpoint
CREATE INDEX `task_runs_status_heartbeat_idx` ON `task_runs` (`status`,`heartbeat_at`);--> statement-breakpoint
ALTER TABLE `task_templates` ADD `batch_id` text;--> statement-breakpoint
ALTER TABLE `task_templates` ADD `timeout_ms` integer;--> statement-breakpoint
CREATE INDEX `task_templates_due_idx` ON `task_templates` (`enabled`,`next_run_at`,`id`);--> statement-breakpoint
ALTER TABLE `tasks` ADD `retry_backoff_ms` integer DEFAULT 30000;--> statement-breakpoint
CREATE INDEX `tasks_queue_idx` ON `tasks` (`status`,`retry_after`,`urgency`,`importance`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `tasks_batch_status_idx` ON `tasks` (`batch_id`,`status`);--> statement-breakpoint
CREATE INDEX `tasks_template_status_idx` ON `tasks` (`template_id`,`status`);
