import type {
  AtomPersistenceKey,
  QueueEvent,
  RunState,
  StoredAtomValue,
} from "@workflow/core";
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
import {
  oauthHandoffs,
  oauthPending,
  oauthRefreshTokens,
  workflowAtomValues,
  workflowEvents,
  workflowQueueItems,
  workflowRunDocuments,
  workflowRunStates,
} from "./schema";

export type WorkflowCloudflareDbLike = {
  select: unknown;
  insert: unknown;
  update: unknown;
  delete: unknown;
};

export type CloudflareWorkflowAdapterOptions = {
  autoMigrate?: boolean;
  leaseMs?: number;
};

export function createCloudflareWorkflowStateStore(
  db: WorkflowCloudflareDbLike,
  options: CloudflareWorkflowAdapterOptions = {},
): WorkflowStateStore {
  return new CloudflareWorkflowStateStore(db, options);
}

export function createCloudflareWorkflowQueue(
  db: WorkflowCloudflareDbLike,
  options: CloudflareWorkflowAdapterOptions = {},
): WorkflowQueue {
  return new CloudflareWorkflowQueue(db, options);
}

export function createCloudflareBrokerStore(
  db: WorkflowCloudflareDbLike,
  options: CloudflareWorkflowAdapterOptions = {},
): BrokerStore {
  return new CloudflareBrokerStore(db, options);
}

class CloudflareWorkflowStateStore implements WorkflowStateStore {
  private ready: Promise<void> | undefined;

  constructor(
    private readonly db: WorkflowCloudflareDbLike,
    private readonly options: CloudflareWorkflowAdapterOptions,
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
    const current = await this.load(runId);
    if (
      expectedVersion !== undefined &&
      current &&
      current.version !== expectedVersion
    ) {
      return { ok: false, reason: "conflict" };
    }
    if (expectedVersion !== undefined && !current && expectedVersion !== 0) {
      return { ok: false, reason: "missing" };
    }

    const now = Date.now();
    const version = (current?.version ?? 0) + 1;
    if (!current) {
      const inserted = await asDb(this.db)
        .insert(workflowRunStates)
        .values({
          runId,
          version,
          stateJson: JSON.stringify(state),
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning({ version: workflowRunStates.version });
      return inserted.length > 0
        ? { ok: true, version }
        : { ok: false, reason: "conflict" };
    }

    const updated = await asDb(this.db)
      .update(workflowRunStates)
      .set({
        version,
        stateJson: JSON.stringify(state),
        updatedAt: now,
      })
      .where(
        and(
          eq(workflowRunStates.runId, runId),
          eq(workflowRunStates.version, current.version),
        ),
      )
      .returning({ version: workflowRunStates.version });
    return updated.length > 0
      ? { ok: true, version }
      : { ok: false, reason: "conflict" };
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
    const rows = await asDb(this.db)
      .select()
      .from(workflowRunDocuments)
      .where(eq(workflowRunDocuments.runId, runId))
      .limit(1);
    const row = (rows as RunDocumentRow[])[0];
    if (!row) return undefined;
    return parseJson<WorkflowRunDocument>(row.documentJson);
  }

  async listRunSummaries(workflowId?: string): Promise<WorkflowRunSummary[]> {
    await this.ensureReady();
    const baseQuery = asDb(this.db).select().from(workflowRunDocuments);
    const rows = await (workflowId
      ? baseQuery.where(eq(workflowRunDocuments.workflowId, workflowId))
      : baseQuery
    ).orderBy(
      sql`${workflowRunDocuments.startedAt} desc`,
      sql`${workflowRunDocuments.publishedAt} desc`,
    );
    return (rows as RunDocumentRow[]).map((row) =>
      parseJson<WorkflowRunSummary>(row.summaryJson),
    );
  }

  async loadAtomValue(
    key: AtomPersistenceKey,
  ): Promise<StoredAtomValue | undefined> {
    await this.ensureReady();
    const rows = await asDb(this.db)
      .select()
      .from(workflowAtomValues)
      .where(eq(workflowAtomValues.cacheKey, atomValueKey(key)))
      .limit(1);
    const row = (rows as AtomValueRow[])[0];
    if (!row) return undefined;
    return {
      value: parseJson<unknown>(row.valueJson),
      deps: parseJson<string[]>(row.depsJson),
      dependencyFingerprint: row.dependencyFingerprint,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async saveAtomValue(
    key: AtomPersistenceKey,
    value: Omit<StoredAtomValue, "createdAt" | "updatedAt">,
  ): Promise<void> {
    await this.ensureReady();
    const cacheKey = atomValueKey(key);
    const now = Date.now();
    const current = await this.loadAtomValue(key);
    await asDb(this.db)
      .insert(workflowAtomValues)
      .values({
        cacheKey,
        workflowId: key.workflowId,
        workflowVersion: key.workflowVersion,
        workflowCodeHash: key.workflowCodeHash,
        atomId: key.atomId,
        scope: key.scope,
        scopeId: key.scopeId,
        valueJson: JSON.stringify(value.value),
        depsJson: JSON.stringify(value.deps),
        dependencyFingerprint: value.dependencyFingerprint,
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: workflowAtomValues.cacheKey,
        set: {
          valueJson: JSON.stringify(value.value),
          depsJson: JSON.stringify(value.deps),
          dependencyFingerprint: value.dependencyFingerprint,
          updatedAt: now,
        },
      });
  }

  private ensureReady(): Promise<void> {
    void this.options;
    this.ready ??= Promise.resolve();
    return this.ready;
  }
}

class CloudflareWorkflowQueue implements WorkflowQueue {
  private ready: Promise<void> | undefined;

  constructor(
    private readonly db: WorkflowCloudflareDbLike,
    private readonly options: CloudflareWorkflowAdapterOptions,
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
    for (let index = 0; index < events.length; index += maxInsertRows) {
      const batch = events.slice(index, index + maxInsertRows);
      await asDb(this.db)
        .insert(workflowQueueItems)
        .values(
          batch.map((event) => ({
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
  }

  async claimNext(runId: string): Promise<QueueItem | undefined> {
    await this.ensureReady();
    for (let i = 0; i < 5; i += 1) {
      const rows = await asDb(this.db)
        .select()
        .from(workflowQueueItems)
        .where(
          and(
            eq(workflowQueueItems.runId, runId),
            eq(workflowQueueItems.status, "pending"),
          ),
        )
        .orderBy(asc(workflowQueueItems.enqueuedAt))
        .limit(1);
      const row = (rows as QueueRow[])[0];
      if (!row) return undefined;

      const now = Date.now();
      const updated = await asDb(this.db)
        .update(workflowQueueItems)
        .set({
          status: "running",
          startedAt: now,
          leaseUntil: now + (this.options.leaseMs ?? 30_000),
          attempts: sql`${workflowQueueItems.attempts} + 1`,
        })
        .where(
          and(
            eq(workflowQueueItems.eventId, row.eventId),
            eq(workflowQueueItems.status, "pending"),
          ),
        )
        .returning();
      const claimed = (updated as QueueRow[])[0];
      if (claimed) return rowToQueueItem(claimed);
    }
    return undefined;
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
      pending: filterQueue(items, "pending"),
      running: filterQueue(items, "running"),
      completed: filterQueue(items, "completed"),
      failed: filterQueue(items, "failed"),
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
    void this.options;
    this.ready ??= Promise.resolve();
    return this.ready;
  }
}

class CloudflareBrokerStore implements BrokerStore {
  private readonly pendingTtlMs = 5 * 60_000;
  private readonly handoffTtlMs = 60_000;
  private ready: Promise<void> | undefined;

  constructor(
    private readonly db: WorkflowCloudflareDbLike,
    private readonly options: CloudflareWorkflowAdapterOptions,
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
    const value: RefreshValue = { ...existing, refreshToken };
    await asDb(this.db)
      .update(oauthRefreshTokens)
      .set({ valueJson: JSON.stringify(value) })
      .where(eq(oauthRefreshTokens.sessionId, sessionId));
  }

  private ensureReady(): Promise<void> {
    void this.options;
    this.ready ??= Promise.resolve();
    return this.ready;
  }
}

function filterQueue(items: QueueItem[], status: QueueItemStatus): QueueItem[] {
  return items.filter((item) => item.status === status);
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

type AtomValueRow = {
  valueJson: string;
  depsJson: string;
  dependencyFingerprint: string;
  createdAt: number;
  updatedAt: number;
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

// D1 has a lower SQL variable limit than Postgres; each queue row binds seven
// values, so keep bulk inserts comfortably below that ceiling.
const maxInsertRows = 10;

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function atomValueKey(key: AtomPersistenceKey): string {
  return JSON.stringify([
    key.workflowId,
    key.workflowVersion,
    key.workflowCodeHash ?? "",
    key.atomId,
    key.scope,
    key.scopeId,
  ]);
}

function randomId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)
  );
}

function asDb(db: WorkflowCloudflareDbLike) {
  return db as never as {
    select: (...args: unknown[]) => {
      from: (table: unknown) => QueryBuilder;
    };
    insert: (table: unknown) => InsertBuilder;
    update: (table: unknown) => UpdateBuilder;
    delete: (table: unknown) => DeleteBuilder;
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
  onConflictDoUpdate(args: unknown): Promise<unknown>;
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
};
