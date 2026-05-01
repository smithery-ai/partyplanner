import type { QueueEvent, RunState } from "@workflow/core";
import type {
  BrokerStore,
  HandoffValue,
  PendingValue,
  RefreshValue,
} from "@workflow/oauth-broker";
import type {
  QueueItem,
  QueueItemStatus,
  QueueSnapshot,
  RunEvent,
  SaveResult,
  StoredRunState,
} from "@workflow/runtime";
import {
  summarizeRun,
  type WorkflowQueue,
  type WorkflowRunDocument,
  type WorkflowRunSummary,
  type WorkflowStateStore,
} from "@workflow/server";
import { and, asc, eq, sql } from "drizzle-orm";
import { ensureWorkflowPostgresSchema } from "./migrate";
import {
  oauthHandoffs,
  oauthPending,
  oauthRefreshTokens,
  workflowEvents,
  workflowQueueItems,
  workflowRunDocuments,
  workflowRunStates,
} from "./schema";

export type WorkflowPostgresDb = {
  execute: unknown;
  select: unknown;
  insert: unknown;
  update: unknown;
  delete: unknown;
};

export type PostgresWorkflowAdapterOptions = {
  autoMigrate?: boolean;
  leaseMs?: number;
};

export function createPostgresWorkflowStateStore(
  db: WorkflowPostgresDb,
  options: PostgresWorkflowAdapterOptions = {},
): WorkflowStateStore {
  return new PostgresWorkflowStateStore(db, options);
}

export function createPostgresWorkflowQueue(
  db: WorkflowPostgresDb,
  options: PostgresWorkflowAdapterOptions = {},
): WorkflowQueue {
  return new PostgresWorkflowQueue(db, options);
}

export function createPostgresBrokerStore(
  db: WorkflowPostgresDb,
  options: PostgresWorkflowAdapterOptions = {},
): BrokerStore {
  return new PostgresBrokerStore(db, options);
}

class PostgresWorkflowStateStore implements WorkflowStateStore {
  private ready: Promise<void> | undefined;

  constructor(
    private readonly db: WorkflowPostgresDb,
    private readonly options: PostgresWorkflowAdapterOptions,
  ) {}

  async load(runId: string): Promise<StoredRunState | undefined> {
    await this.ensureReady();
    const rows = await asDb(this.db)
      .select()
      .from(workflowRunStates)
      .where(eq(workflowRunStates.runId, runId))
      .limit(1);
    const row = (rows as RunStateRow[])[0];
    if (!row) return undefined;
    return {
      version: row.version,
      state: parseJson<RunState>(row.stateJson),
    };
  }

  async save(
    runId: string,
    state: RunState,
    expectedVersion?: number,
  ): Promise<SaveResult> {
    await this.ensureReady();
    const now = Date.now();
    const stateJson = JSON.stringify(state);

    // First-write path: caller asserts no row exists yet.
    if (expectedVersion === 0) {
      const inserted = (await asDb(this.db)
        .insert(workflowRunStates)
        .values({ runId, version: 1, stateJson, updatedAt: now })
        .onConflictDoNothing()
        .returning({ version: workflowRunStates.version })) as Array<{
        version: number;
      }>;
      return inserted.length > 0
        ? { ok: true, version: 1 }
        : { ok: false, reason: "conflict" };
    }

    // Optimistic update against a known version.
    if (expectedVersion !== undefined) {
      const nextVersion = expectedVersion + 1;
      const updated = (await asDb(this.db)
        .update(workflowRunStates)
        .set({ version: nextVersion, stateJson, updatedAt: now })
        .where(
          and(
            eq(workflowRunStates.runId, runId),
            eq(workflowRunStates.version, expectedVersion),
          ),
        )
        .returning({ version: workflowRunStates.version })) as Array<{
        version: number;
      }>;
      if (updated.length > 0) return { ok: true, version: nextVersion };
      // Disambiguate missing vs. version conflict only on the failure path.
      const exists = (await asDb(this.db)
        .select({ version: workflowRunStates.version })
        .from(workflowRunStates)
        .where(eq(workflowRunStates.runId, runId))
        .limit(1)) as Array<{ version: number }>;
      return {
        ok: false,
        reason: exists.length === 0 ? "missing" : "conflict",
      };
    }

    // No version assertion: upsert in a single round trip.
    const upserted = (await asDb(this.db)
      .insert(workflowRunStates)
      .values({ runId, version: 1, stateJson, updatedAt: now })
      .onConflictDoUpdate({
        target: workflowRunStates.runId,
        set: {
          version: sql`${workflowRunStates.version} + 1`,
          stateJson,
          updatedAt: now,
        },
      })
      .returning({ version: workflowRunStates.version })) as Array<{
      version: number;
    }>;
    return { ok: true, version: upserted[0].version };
  }

  async publishEvent(event: RunEvent): Promise<void> {
    await this.publishEvents([event]);
  }

  async publishEvents(events: RunEvent[]): Promise<void> {
    await this.ensureReady();
    if (events.length === 0) return;
    await asDb(this.db)
      .insert(workflowEvents)
      .values(
        events.map((event) => ({
          id: `event_${randomId()}`,
          runId: event.runId,
          type: event.type,
          eventJson: JSON.stringify(event),
          createdAt: event.at,
        })),
      );
  }

  async listEvents(runId: string): Promise<RunEvent[]> {
    await this.ensureReady();
    const rows = await asDb(this.db)
      .select()
      .from(workflowEvents)
      .where(eq(workflowEvents.runId, runId))
      .orderBy(asc(workflowEvents.createdAt), asc(workflowEvents.id));
    return (rows as EventRow[]).map((row) =>
      parseJson<RunEvent>(row.eventJson),
    );
  }

  async saveRunDocument(document: WorkflowRunDocument): Promise<void> {
    await this.ensureReady();
    const summary = summarizeRun(document);
    await asDb(this.db)
      .insert(workflowRunDocuments)
      .values({
        runId: document.runId,
        workflowId: document.workflow.workflowId,
        status: document.status,
        documentJson: JSON.stringify(document),
        summaryJson: JSON.stringify(summary),
        publishedAt: document.publishedAt,
        startedAt: document.state.startedAt,
      })
      .onConflictDoUpdate({
        target: workflowRunDocuments.runId,
        set: {
          workflowId: document.workflow.workflowId,
          status: document.status,
          documentJson: JSON.stringify(document),
          summaryJson: JSON.stringify(summary),
          publishedAt: document.publishedAt,
          startedAt: document.state.startedAt,
        },
      });
  }

  async getRunDocument(
    runId: string,
  ): Promise<WorkflowRunDocument | undefined> {
    await this.ensureReady();
    // Project only documentJson — every other column on this row is
    // unused at this call site and the document blob alone can be
    // multi-MB. Selecting * here is a primary-egress hot path.
    const rows = await asDb(this.db)
      .select({ documentJson: workflowRunDocuments.documentJson })
      .from(workflowRunDocuments)
      .where(eq(workflowRunDocuments.runId, runId))
      .limit(1);
    const row = (rows as Array<Pick<RunDocumentRow, "documentJson">>)[0];
    if (!row) return undefined;
    return parseJson<WorkflowRunDocument>(row.documentJson);
  }

  async listRunSummaries(workflowId?: string): Promise<WorkflowRunSummary[]> {
    await this.ensureReady();
    // Critical: project only summaryJson. The full row carries documentJson,
    // which holds the entire workflow run state and grows with each pump
    // (commonly multi-MB). Selecting * here was hauling the full document
    // for every list call — the dominant source of egress and buffer-cache
    // pressure on the primary.
    const baseQuery = asDb(this.db)
      .select({ summaryJson: workflowRunDocuments.summaryJson })
      .from(workflowRunDocuments);
    const rows = await (workflowId
      ? baseQuery.where(eq(workflowRunDocuments.workflowId, workflowId))
      : baseQuery
    ).orderBy(
      sql`${workflowRunDocuments.startedAt} desc`,
      sql`${workflowRunDocuments.publishedAt} desc`,
    );
    return (rows as Array<Pick<RunDocumentRow, "summaryJson">>).map((row) =>
      parseJson<WorkflowRunSummary>(row.summaryJson),
    );
  }

  private ensureReady(): Promise<void> {
    if (this.options.autoMigrate === false) return Promise.resolve();
    this.ready ??= ensureWorkflowPostgresSchema(this.db);
    return this.ready;
  }
}

class PostgresWorkflowQueue implements WorkflowQueue {
  private ready: Promise<void> | undefined;

  constructor(
    private readonly db: WorkflowPostgresDb,
    private readonly options: PostgresWorkflowAdapterOptions,
  ) {}

  async enqueue(event: QueueEvent): Promise<void> {
    await this.ensureReady();
    await asDb(this.db)
      .insert(workflowQueueItems)
      .values({
        eventId: event.eventId,
        runId: event.runId,
        kind: event.kind,
        status: "pending",
        eventJson: JSON.stringify(event),
        enqueuedAt: Date.now(),
        attempts: 0,
      })
      .onConflictDoNothing();
  }

  async enqueueMany(events: QueueEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.ensureReady();
    await asDb(this.db)
      .insert(workflowQueueItems)
      .values(
        events.map((event) => ({
          eventId: event.eventId,
          runId: event.runId,
          kind: event.kind,
          status: "pending",
          eventJson: JSON.stringify(event),
          enqueuedAt: Date.now(),
          attempts: 0,
        })),
      )
      .onConflictDoNothing();
  }

  async claimNext(runId: string): Promise<QueueItem | undefined> {
    await this.ensureReady();
    const now = Date.now();
    const leaseUntil = now + (this.options.leaseMs ?? 30_000);
    // Atomic claim: FOR UPDATE SKIP LOCKED lets concurrent claimers each grab
    // a distinct row in one round trip — no SELECT-then-UPDATE retry loop.
    //
    // Eligibility includes pending items AND running items whose lease has
    // expired. Without lease recovery, a worker that dies mid-processNext()
    // leaves the row in `running` forever — claimNext would never return it
    // again, and the run stalls. Re-claiming an expired-lease row is safe
    // because the runtime is responsible for being idempotent across retries
    // (see processedEventIds + emitStep guards).
    const rows = (await asDb(this.db).execute(sql`
      UPDATE workflow_queue_items
      SET status = 'running',
          started_at = ${now},
          lease_until = ${leaseUntil},
          attempts = attempts + 1
      WHERE event_id = (
        SELECT event_id FROM workflow_queue_items
        WHERE run_id = ${runId}
          AND (
            status = 'pending'
            OR (status = 'running' AND lease_until < ${now})
          )
        ORDER BY enqueued_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING
        event_id AS "eventId",
        event_json AS "eventJson",
        status,
        enqueued_at AS "enqueuedAt",
        started_at AS "startedAt",
        finished_at AS "finishedAt",
        error
    `)) as QueueRow[];
    const row = rows[0];
    return row ? rowToQueueItem(row) : undefined;
  }

  async complete(eventId: string): Promise<void> {
    await this.ensureReady();
    await asDb(this.db)
      .update(workflowQueueItems)
      .set({
        status: "completed",
        finishedAt: Date.now(),
      })
      .where(eq(workflowQueueItems.eventId, eventId));
  }

  async fail(eventId: string, error: Error): Promise<void> {
    await this.ensureReady();
    await asDb(this.db)
      .update(workflowQueueItems)
      .set({
        status: "failed",
        finishedAt: Date.now(),
        error: error.message,
      })
      .where(eq(workflowQueueItems.eventId, eventId));
  }

  async snapshot(runId: string): Promise<QueueSnapshot> {
    await this.ensureReady();
    const rows = await asDb(this.db)
      .select()
      .from(workflowQueueItems)
      .where(eq(workflowQueueItems.runId, runId))
      .orderBy(asc(workflowQueueItems.enqueuedAt));
    const items = (rows as QueueRow[]).map(rowToQueueItem);
    return {
      pending: items.filter((item) => item.status === "pending"),
      running: items.filter((item) => item.status === "running"),
      completed: items.filter((item) => item.status === "completed"),
      failed: items.filter((item) => item.status === "failed"),
    };
  }

  async size(runId: string): Promise<number> {
    await this.ensureReady();
    const rows = await asDb(this.db)
      .select({ eventId: workflowQueueItems.eventId })
      .from(workflowQueueItems)
      .where(
        and(
          eq(workflowQueueItems.runId, runId),
          eq(workflowQueueItems.status, "pending"),
        ),
      );
    return rows.length;
  }

  private ensureReady(): Promise<void> {
    if (this.options.autoMigrate === false) return Promise.resolve();
    this.ready ??= ensureWorkflowPostgresSchema(this.db);
    return this.ready;
  }
}

class PostgresBrokerStore implements BrokerStore {
  private readonly pendingTtlMs = 5 * 60_000;
  private readonly handoffTtlMs = 60_000;
  private ready: Promise<void> | undefined;

  constructor(
    private readonly db: WorkflowPostgresDb,
    private readonly options: PostgresWorkflowAdapterOptions,
  ) {}

  async putPending(state: string, value: PendingValue): Promise<void> {
    await this.ensureReady();
    await asDb(this.db)
      .insert(oauthPending)
      .values({
        state,
        valueJson: JSON.stringify(value),
        createdAt: value.createdAt,
      })
      .onConflictDoUpdate({
        target: oauthPending.state,
        set: {
          valueJson: JSON.stringify(value),
          createdAt: value.createdAt,
        },
      });
  }

  async takePending(state: string): Promise<PendingValue | undefined> {
    await this.ensureReady();
    const rows = await asDb(this.db)
      .select()
      .from(oauthPending)
      .where(eq(oauthPending.state, state))
      .limit(1);
    const row = (rows as ValueJsonRow[])[0];
    if (!row) return undefined;
    await asDb(this.db)
      .delete(oauthPending)
      .where(eq(oauthPending.state, state));
    const value = parseJson<PendingValue>(row.valueJson);
    if (Date.now() - value.createdAt > this.pendingTtlMs) return undefined;
    return value;
  }

  async putHandoff(handoff: string, value: HandoffValue): Promise<void> {
    await this.ensureReady();
    await asDb(this.db)
      .insert(oauthHandoffs)
      .values({
        handoff,
        valueJson: JSON.stringify(value),
        createdAt: value.createdAt,
      })
      .onConflictDoUpdate({
        target: oauthHandoffs.handoff,
        set: {
          valueJson: JSON.stringify(value),
          createdAt: value.createdAt,
        },
      });
  }

  async takeHandoff(handoff: string): Promise<HandoffValue | undefined> {
    await this.ensureReady();
    const rows = await asDb(this.db)
      .select()
      .from(oauthHandoffs)
      .where(eq(oauthHandoffs.handoff, handoff))
      .limit(1);
    const row = (rows as ValueJsonRow[])[0];
    if (!row) return undefined;
    await asDb(this.db)
      .delete(oauthHandoffs)
      .where(eq(oauthHandoffs.handoff, handoff));
    const value = parseJson<HandoffValue>(row.valueJson);
    if (Date.now() - value.createdAt > this.handoffTtlMs) return undefined;
    return value;
  }

  async putRefresh(sessionId: string, value: RefreshValue): Promise<void> {
    await this.ensureReady();
    await asDb(this.db)
      .insert(oauthRefreshTokens)
      .values({
        sessionId,
        valueJson: JSON.stringify(value),
        createdAt: value.createdAt,
      })
      .onConflictDoUpdate({
        target: oauthRefreshTokens.sessionId,
        set: {
          valueJson: JSON.stringify(value),
          createdAt: value.createdAt,
        },
      });
  }

  async getRefresh(sessionId: string): Promise<RefreshValue | undefined> {
    await this.ensureReady();
    const rows = await asDb(this.db)
      .select()
      .from(oauthRefreshTokens)
      .where(eq(oauthRefreshTokens.sessionId, sessionId))
      .limit(1);
    const row = (rows as ValueJsonRow[])[0];
    if (!row) return undefined;
    return parseJson<RefreshValue>(row.valueJson);
  }

  async updateRefreshToken(
    sessionId: string,
    refreshToken: string,
  ): Promise<void> {
    await this.ensureReady();
    const existing = await this.getRefresh(sessionId);
    if (!existing) return;
    await asDb(this.db)
      .update(oauthRefreshTokens)
      .set({
        valueJson: JSON.stringify({ ...existing, refreshToken }),
      })
      .where(eq(oauthRefreshTokens.sessionId, sessionId));
  }

  private ensureReady(): Promise<void> {
    if (this.options.autoMigrate === false) return Promise.resolve();
    this.ready ??= ensureWorkflowPostgresSchema(this.db);
    return this.ready;
  }
}

function rowToQueueItem(row: {
  eventJson: string;
  status: string;
  enqueuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
}): QueueItem {
  return {
    event: parseJson<QueueEvent>(row.eventJson),
    status: row.status as QueueItemStatus,
    enqueuedAt: row.enqueuedAt,
    startedAt: row.startedAt ?? undefined,
    finishedAt: row.finishedAt ?? undefined,
    error: row.error ?? undefined,
  };
}

type RunStateRow = {
  version: number;
  stateJson: string;
};

type RunDocumentRow = {
  documentJson: string;
  summaryJson: string;
};

type EventRow = {
  eventJson: string;
};

type QueueRow = {
  eventId: string;
  eventJson: string;
  status: string;
  enqueuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
};

type ValueJsonRow = {
  valueJson: string;
};

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function randomId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)
  );
}

function asDb(db: WorkflowPostgresDb) {
  return db as never as {
    select: (...args: unknown[]) => {
      from: (table: unknown) => QueryBuilder;
    };
    insert: (table: unknown) => InsertBuilder;
    update: (table: unknown) => UpdateBuilder;
    delete: (table: unknown) => DeleteBuilder;
    execute: (query: unknown) => Promise<unknown[]>;
  };
}

type QueryBuilder = {
  where(condition: unknown): QueryBuilder;
  orderBy(...columns: unknown[]): QueryBuilder;
  limit(limit: number): Promise<unknown[]>;
  then<TResult1 = unknown[], TResult2 = never>(
    onfulfilled?:
      | ((value: unknown[]) => TResult1 | PromiseLike<TResult1>)
      | undefined
      | null,
    onrejected?:
      | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
      | undefined
      | null,
  ): PromiseLike<TResult1 | TResult2>;
};

type InsertBuilder = {
  values(value: unknown): InsertBuilder;
  onConflictDoNothing(): InsertBuilder;
  onConflictDoUpdate(args: unknown): InsertBuilder;
  returning(selection?: unknown): Promise<unknown[]>;
  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?:
      | ((value: unknown) => TResult1 | PromiseLike<TResult1>)
      | undefined
      | null,
    onrejected?:
      | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
      | undefined
      | null,
  ): PromiseLike<TResult1 | TResult2>;
};

type UpdateBuilder = {
  set(value: unknown): UpdateBuilder;
  where(condition: unknown): UpdateBuilder;
  returning(selection?: unknown): Promise<unknown[]>;
  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?:
      | ((value: unknown) => TResult1 | PromiseLike<TResult1>)
      | undefined
      | null,
    onrejected?:
      | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
      | undefined
      | null,
  ): PromiseLike<TResult1 | TResult2>;
};

type DeleteBuilder = {
  where(condition: unknown): Promise<unknown>;
  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?:
      | ((value: unknown) => TResult1 | PromiseLike<TResult1>)
      | undefined
      | null,
    onrejected?:
      | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
      | undefined
      | null,
  ): PromiseLike<TResult1 | TResult2>;
};
