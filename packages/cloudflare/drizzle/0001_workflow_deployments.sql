CREATE TABLE `workflow_deployments` (
	`deployment_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`label` text,
	`workflow_api_url` text,
	`dispatch_namespace` text NOT NULL,
	`tags_json` text NOT NULL,
	`created_at` real NOT NULL,
	`updated_at` real NOT NULL
);
--> statement-breakpoint
CREATE INDEX `workflow_deployments_tenant_id_updated_at_idx` ON `workflow_deployments` (`tenant_id`,`updated_at`);
