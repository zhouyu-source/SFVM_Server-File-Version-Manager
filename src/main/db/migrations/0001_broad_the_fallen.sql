CREATE TABLE `script_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`target_id` text NOT NULL,
	`job_id` text NOT NULL,
	`trigger` text DEFAULT 'step' NOT NULL,
	`pipeline_id` text,
	`title` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`started_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`finished_at` text,
	`operator` text,
	`error_message` text,
	FOREIGN KEY (`target_id`) REFERENCES `targets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_script_runs_target_time` ON `script_runs` (`target_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `script_step_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`shell` text,
	`status` text DEFAULT 'running' NOT NULL,
	`exit_code` integer,
	`started_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`finished_at` text,
	`duration_ms` integer,
	`output_path` text,
	`output_bytes` integer DEFAULT 0 NOT NULL,
	`truncated` integer DEFAULT false NOT NULL,
	`output_tail` text,
	`error_message` text,
	FOREIGN KEY (`run_id`) REFERENCES `script_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_script_step_runs_run_seq` ON `script_step_runs` (`run_id`,`seq`);