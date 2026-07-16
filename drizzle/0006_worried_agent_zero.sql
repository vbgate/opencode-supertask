ALTER TABLE `task_runs` ADD `launch_protocol` text;--> statement-breakpoint
CREATE INDEX `tasks_cleanup_idx` ON `tasks` (`finished_at`,`id`,`status`);