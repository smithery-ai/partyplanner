CREATE TABLE `oauth_handoffs` (
	`handoff` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL,
	`created_at` real NOT NULL
);
--> statement-breakpoint
CREATE TABLE `oauth_pending` (
	`state` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL,
	`created_at` real NOT NULL
);
--> statement-breakpoint
CREATE TABLE `oauth_refresh_tokens` (
	`session_id` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL,
	`created_at` real NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workflow_events` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`type` text NOT NULL,
	`event_json` text NOT NULL,
	`created_at` real NOT NULL
);
--> statement-breakpoint
CREATE INDEX `workflow_events_run_id_created_at_idx` ON `workflow_events` (`run_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `workflow_queue_items` (
	`event_id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`event_json` text NOT NULL,
	`enqueued_at` real NOT NULL,
	`started_at` real,
	`finished_at` real,
	`lease_until` real,
	`attempts` integer NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `workflow_queue_items_run_id_status_idx` ON `workflow_queue_items` (`run_id`,`status`,`enqueued_at`);--> statement-breakpoint
CREATE TABLE `workflow_run_documents` (
	`run_id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`status` text NOT NULL,
	`document_json` text NOT NULL,
	`summary_json` text NOT NULL,
	`published_at` real NOT NULL,
	`started_at` real NOT NULL
);
--> statement-breakpoint
CREATE INDEX `workflow_run_documents_started_at_idx` ON `workflow_run_documents` ("started_at" desc);--> statement-breakpoint
CREATE TABLE `workflow_run_states` (
	`run_id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`state_json` text NOT NULL,
	`updated_at` real NOT NULL
);
