import { doublePrecision, integer, pgTable, text } from "drizzle-orm/pg-core";

export const workflowRunStates = pgTable("workflow_run_states", {
  runId: text("run_id").primaryKey(),
  version: integer("version").notNull(),
  stateJson: text("state_json").notNull(),
  updatedAt: doublePrecision("updated_at").notNull(),
});

export const workflowRunDocuments = pgTable("workflow_run_documents", {
  runId: text("run_id").primaryKey(),
  workflowId: text("workflow_id").notNull(),
  status: text("status").notNull(),
  documentJson: text("document_json").notNull(),
  summaryJson: text("summary_json").notNull(),
  publishedAt: doublePrecision("published_at").notNull(),
  startedAt: doublePrecision("started_at").notNull(),
});

export const workflowEvents = pgTable("workflow_events", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  type: text("type").notNull(),
  eventJson: text("event_json").notNull(),
  createdAt: doublePrecision("created_at").notNull(),
});

export const workflowQueueItems = pgTable("workflow_queue_items", {
  eventId: text("event_id").primaryKey(),
  runId: text("run_id").notNull(),
  kind: text("kind").notNull(),
  status: text("status").notNull(),
  eventJson: text("event_json").notNull(),
  enqueuedAt: doublePrecision("enqueued_at").notNull(),
  startedAt: doublePrecision("started_at"),
  finishedAt: doublePrecision("finished_at"),
  leaseUntil: doublePrecision("lease_until"),
  attempts: integer("attempts").notNull(),
  error: text("error"),
});
