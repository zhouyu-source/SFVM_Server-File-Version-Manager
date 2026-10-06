CREATE TABLE `pipeline_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`pipeline_id` text NOT NULL,
	`seq` integer NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`script` text DEFAULT '' NOT NULL,
	`shell` text,
	`cwd` text,
	`timeout_ms` integer NOT NULL,
	`on_failure` text DEFAULT 'stop' NOT NULL,
	FOREIGN KEY (`pipeline_id`) REFERENCES `pipelines`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_pipeline_steps_pipeline_seq` ON `pipeline_steps` (`pipeline_id`,`seq`);--> statement-breakpoint
CREATE TABLE `pipelines` (
	`id` text PRIMARY KEY NOT NULL,
	`target_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`target_id`) REFERENCES `targets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_pipelines_target` ON `pipelines` (`target_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_pipelines_target_name` ON `pipelines` (`target_id`,`name`);