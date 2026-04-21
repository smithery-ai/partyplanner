import { sql } from "drizzle-orm";
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

export const workflowRunStates = sqliteTable("workflow_run_states", {
  runId: text("run_id").primaryKey(),
  version: integer("version").notNull(),
  stateJson: text("state_json").notNull(),
  updatedAt: real("updated_at").notNull(),
});

export const workflowRunDocuments = sqliteTable(
  "workflow_run_documents",
  {
    runId: text("run_id").primaryKey(),
    workflowId: text("workflow_id").notNull(),
    status: text("status").notNull(),
    documentJson: text("document_json").notNull(),
    summaryJson: text("summary_json").notNull(),
    publishedAt: real("published_at").notNull(),
    startedAt: real("started_at").notNull(),
  },
  (table) => [
    index("workflow_run_documents_started_at_idx").on(
      sql`${table.startedAt} desc`,
    ),
  ],
);

export const workflowEvents = sqliteTable(
  "workflow_events",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    type: text("type").notNull(),
    eventJson: text("event_json").notNull(),
    createdAt: real("created_at").notNull(),
  },
  (table) => [
    index("workflow_events_run_id_created_at_idx").on(
      table.runId,
      table.createdAt,
    ),
  ],
);

export const workflowQueueItems = sqliteTable(
  "workflow_queue_items",
  {
    eventId: text("event_id").primaryKey(),
    runId: text("run_id").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    eventJson: text("event_json").notNull(),
    enqueuedAt: real("enqueued_at").notNull(),
    startedAt: real("started_at"),
    finishedAt: real("finished_at"),
    leaseUntil: real("lease_until"),
    attempts: integer("attempts").notNull(),
    error: text("error"),
  },
  (table) => [
    index("workflow_queue_items_run_id_status_idx").on(
      table.runId,
      table.status,
      table.enqueuedAt,
    ),
  ],
);

export const oauthPending = sqliteTable("oauth_pending", {
  state: text("state").primaryKey(),
  valueJson: text("value_json").notNull(),
  createdAt: real("created_at").notNull(),
});

export const oauthHandoffs = sqliteTable("oauth_handoffs", {
  handoff: text("handoff").primaryKey(),
  valueJson: text("value_json").notNull(),
  createdAt: real("created_at").notNull(),
});

export const oauthRefreshTokens = sqliteTable("oauth_refresh_tokens", {
  sessionId: text("session_id").primaryKey(),
  valueJson: text("value_json").notNull(),
  createdAt: real("created_at").notNull(),
});
