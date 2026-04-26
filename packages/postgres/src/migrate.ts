import { sql } from "drizzle-orm";

export type WorkflowPostgresMigrationDb = {
  execute: unknown;
};

export async function ensureWorkflowPostgresSchema(
  db: WorkflowPostgresMigrationDb,
): Promise<void> {
  for (const statement of schemaStatements) {
    await execute(db, sql.raw(statement));
  }
}

const schemaStatements = [
  `create table if not exists workflow_run_states (
    run_id text primary key,
    version integer not null,
    state_json text not null,
    updated_at double precision not null
  )`,
  `create table if not exists workflow_run_documents (
    run_id text primary key,
    workflow_id text not null,
    status text not null,
    document_json text not null,
    summary_json text not null,
    published_at double precision not null,
    started_at double precision not null
  )`,
  `create table if not exists workflow_events (
    id text primary key,
    run_id text not null,
    type text not null,
    event_json text not null,
    created_at double precision not null
  )`,
  `create table if not exists workflow_queue_items (
    event_id text primary key,
    run_id text not null,
    kind text not null,
    status text not null,
    event_json text not null,
    enqueued_at double precision not null,
    started_at double precision,
    finished_at double precision,
    lease_until double precision,
    attempts integer not null,
    error text
  )`,
  `create table if not exists oauth_pending (
    state text primary key,
    value_json text not null,
    created_at double precision not null
  )`,
  `create table if not exists oauth_handoffs (
    handoff text primary key,
    value_json text not null,
    created_at double precision not null
  )`,
  `create table if not exists oauth_refresh_tokens (
    session_id text primary key,
    value_json text not null,
    created_at double precision not null
  )`,
  `create table if not exists provider_installations (
    installation_key text primary key,
    provider_id text not null,
    deployment_id text,
    identity_json text not null,
    runtime_handoff_url text not null,
    created_at double precision not null,
    updated_at double precision not null
  )`,
  `alter table provider_installations
    alter column deployment_id drop not null`,
  `create table if not exists workflow_deployments (
    deployment_id text primary key,
    tenant_id text not null,
    label text,
    workflow_api_url text,
    workflow_target_url text,
    dispatch_namespace text not null,
    tags_json text not null,
    created_at double precision not null,
    updated_at double precision not null
  )`,
  `alter table workflow_deployments
    add column if not exists workflow_target_url text`,
  `create index if not exists workflow_run_documents_started_at_idx
    on workflow_run_documents (started_at desc)`,
  `create index if not exists workflow_events_run_id_created_at_idx
    on workflow_events (run_id, created_at)`,
  `create index if not exists workflow_queue_items_run_id_status_idx
    on workflow_queue_items (run_id, status, enqueued_at)`,
  `create index if not exists provider_installations_provider_id_idx
    on provider_installations (provider_id, updated_at desc)`,
  `create index if not exists workflow_deployments_tenant_id_updated_at_idx
    on workflow_deployments (tenant_id, updated_at desc)`,
];

function execute(
  db: WorkflowPostgresMigrationDb,
  query: unknown,
): Promise<unknown> {
  return Promise.resolve(
    (db as { execute(query: unknown): Promise<unknown> | unknown }).execute(
      query,
    ),
  );
}
