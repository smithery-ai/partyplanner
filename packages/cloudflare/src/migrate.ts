import { sql } from "drizzle-orm";

export type WorkflowCloudflareMigrationDb = {
  run: unknown;
  values: unknown;
  transaction?: unknown;
};

export function migrateWorkflowCloudflareSchema(
  db: WorkflowCloudflareMigrationDb,
): Promise<void> {
  run(db, migrationTableStatement);
  const applied = new Set(
    values(db, "select id from __workflow_cloudflare_migrations").map((row) =>
      String(row[0]),
    ),
  );

  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    transaction(db, (tx) => {
      for (const statement of migration.statements) run(tx, statement);
      run(
        tx,
        `insert into __workflow_cloudflare_migrations (id, applied_at)
          values ('${migration.id}', ${Date.now()})`,
      );
    });
  }

  return Promise.resolve();
}

const migrationTableStatement = `
  create table if not exists __workflow_cloudflare_migrations (
    id text primary key,
    applied_at real not null
  )
`;

const migrations = [
  {
    id: "0000_initial_workflow_cloudflare_schema",
    statements: [
      `create table if not exists oauth_handoffs (
        handoff text primary key not null,
        value_json text not null,
        created_at real not null
      )`,
      `create table if not exists oauth_pending (
        state text primary key not null,
        value_json text not null,
        created_at real not null
      )`,
      `create table if not exists oauth_refresh_tokens (
        session_id text primary key not null,
        value_json text not null,
        created_at real not null
      )`,
      `create table if not exists workflow_events (
        id text primary key not null,
        run_id text not null,
        type text not null,
        event_json text not null,
        created_at real not null
      )`,
      `create index if not exists workflow_events_run_id_created_at_idx
        on workflow_events (run_id, created_at)`,
      `create table if not exists workflow_queue_items (
        event_id text primary key not null,
        run_id text not null,
        kind text not null,
        status text not null,
        event_json text not null,
        enqueued_at real not null,
        started_at real,
        finished_at real,
        lease_until real,
        attempts integer not null,
        error text
      )`,
      `create index if not exists workflow_queue_items_run_id_status_idx
        on workflow_queue_items (run_id, status, enqueued_at)`,
      `create table if not exists workflow_run_documents (
        run_id text primary key not null,
        workflow_id text not null,
        status text not null,
        document_json text not null,
        summary_json text not null,
        published_at real not null,
        started_at real not null
      )`,
      `create index if not exists workflow_run_documents_started_at_idx
        on workflow_run_documents (started_at desc)`,
      `create table if not exists workflow_run_states (
        run_id text primary key not null,
        version integer not null,
        state_json text not null,
        updated_at real not null
      )`,
    ],
  },
];

function run(db: WorkflowCloudflareMigrationDb, statement: string): void {
  (
    db as {
      run(query: unknown): unknown;
    }
  ).run(sql.raw(statement));
}

function values(
  db: WorkflowCloudflareMigrationDb,
  statement: string,
): unknown[][] {
  return (
    db as {
      values(query: unknown): unknown[][];
    }
  ).values(sql.raw(statement));
}

function transaction(
  db: WorkflowCloudflareMigrationDb,
  callback: (tx: WorkflowCloudflareMigrationDb) => void,
): void {
  const candidate = db as {
    transaction?: (
      callback: (tx: WorkflowCloudflareMigrationDb) => void,
    ) => void;
  };
  if (candidate.transaction) {
    candidate.transaction(callback);
    return;
  }
  callback(db);
}
