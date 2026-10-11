ALTER TABLE `releases` ADD `recovery_required` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `releases` ADD `recovery_info` text;
