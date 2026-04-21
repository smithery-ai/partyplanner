CREATE TABLE `workflow_atom_values` (
	`cache_key` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`workflow_version` text NOT NULL,
	`workflow_code_hash` text,
	`atom_id` text NOT NULL,
	`scope` text NOT NULL,
	`scope_id` text NOT NULL,
	`value_json` text NOT NULL,
	`deps_json` text NOT NULL,
	`dependency_fingerprint` text NOT NULL,
	`created_at` real NOT NULL,
	`updated_at` real NOT NULL
);
--> statement-breakpoint
CREATE INDEX `workflow_atom_values_lookup_idx` ON `workflow_atom_values` (`workflow_id`,`workflow_version`,`workflow_code_hash`,`atom_id`,`scope`,`scope_id`);
