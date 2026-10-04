CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `archives` (
	`id` text PRIMARY KEY NOT NULL,
	`target_id` text NOT NULL,
	`version_tag` text NOT NULL,
	`storage_path` text NOT NULL,
	`payload_path` text NOT NULL,
	`kind` text NOT NULL,
	`root_hash` text NOT NULL,
	`total_bytes` integer NOT NULL,
	`file_count` integer NOT NULL,
	`archived_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`release_id` text,
	`note` text,
	`status` text DEFAULT 'valid' NOT NULL,
	FOREIGN KEY (`target_id`) REFERENCES `targets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_archives_target_time` ON `archives` (`target_id`,`archived_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_archives_target_tag` ON `archives` (`target_id`,`version_tag`);--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`level` text NOT NULL,
	`scope` text NOT NULL,
	`ref_id` text,
	`message` text NOT NULL,
	`detail` text
);
--> statement-breakpoint
CREATE INDEX `idx_audit_ts` ON `audit_logs` (`ts`);--> statement-breakpoint
CREATE TABLE `connections` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`host` text NOT NULL,
	`port` integer DEFAULT 22 NOT NULL,
	`username` text NOT NULL,
	`auth_type` text NOT NULL,
	`secret_cipher` text,
	`private_key_path` text,
	`host_key_fingerprint` text,
	`keepalive_ms` integer DEFAULT 15000 NOT NULL,
	`auto_connect` integer DEFAULT false NOT NULL,
	`last_connected_at` text,
	`remark` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `environments` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`env_type` text NOT NULL,
	`description` text,
	`connection_id` text NOT NULL,
	`color` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `environments_name_unique` ON `environments` (`name`);--> statement-breakpoint
CREATE TABLE `known_hosts` (
	`id` text PRIMARY KEY NOT NULL,
	`host` text NOT NULL,
	`port` integer NOT NULL,
	`key_type` text NOT NULL,
	`fingerprint` text NOT NULL,
	`trusted_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_known_hosts_host_port_type` ON `known_hosts` (`host`,`port`,`key_type`);--> statement-breakpoint
CREATE TABLE `release_items` (
	`id` text PRIMARY KEY NOT NULL,
	`release_id` text NOT NULL,
	`rel_path` text NOT NULL,
	`hash` text NOT NULL,
	`size` integer NOT NULL,
	`mtime` text,
	FOREIGN KEY (`release_id`) REFERENCES `releases`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_release_items_release_path` ON `release_items` (`release_id`,`rel_path`);--> statement-breakpoint
CREATE TABLE `releases` (
	`id` text PRIMARY KEY NOT NULL,
	`target_id` text NOT NULL,
	`action` text NOT NULL,
	`version_tag` text NOT NULL,
	`status` text NOT NULL,
	`source` text,
	`local_path` text,
	`archive_id` text,
	`root_hash` text,
	`total_bytes` integer DEFAULT 0 NOT NULL,
	`file_count` integer DEFAULT 0 NOT NULL,
	`operator` text,
	`note` text,
	`current_step` text,
	`error_message` text,
	`started_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`target_id`) REFERENCES `targets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_releases_target_time` ON `releases` (`target_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `targets` (
	`id` text PRIMARY KEY NOT NULL,
	`environment_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`remote_path` text NOT NULL,
	`archive_dir` text,
	`local_path` text,
	`local_exclude` text,
	`hash_algo` text DEFAULT 'sha256' NOT NULL,
	`verify_remote` integer DEFAULT true NOT NULL,
	`retain_policy` text,
	`deploy_strategy` text DEFAULT 'rename' NOT NULL,
	`auto_connect` integer DEFAULT false NOT NULL,
	`last_deploy_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_targets_env_path` ON `targets` (`environment_id`,`remote_path`);