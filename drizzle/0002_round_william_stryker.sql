CREATE TABLE `task_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` integer NOT NULL,
	`session_id` text,
	`model` text,
	`status` text DEFAULT 'running',
	`started_at` integer,
	`finished_at` integer,
	`log` text,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
