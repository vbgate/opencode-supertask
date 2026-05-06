CREATE TABLE `tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`agent` text NOT NULL,
	`model` text DEFAULT 'default',
	`prompt` text NOT NULL,
	`category` text DEFAULT 'general',
	`importance` integer DEFAULT 3,
	`urgency` integer DEFAULT 3,
	`batch_id` text,
	`depends_on` integer,
	`status` text DEFAULT 'pending',
	`created_at` integer,
	`started_at` integer,
	`finished_at` integer,
	`result_log` text,
	`retry_count` integer DEFAULT 0,
	`max_retries` integer DEFAULT 3
);
