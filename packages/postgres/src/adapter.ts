import type {
  AtomPersistenceKey,
  QueueEvent,
  RunState,
  StoredAtomValue,
} from "@workflow/core";
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
  workflowAtomValues,
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

function asDb(db: WorkflowPostgresDb) {
  return db as never as {
    select: (...args: unknown[]) => {
      from: (table: unknown) => QueryBuilder;
    };
    insert: (table: unknown) => InsertBuilder;
    update: (table: unknown) => UpdateBuilder;
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
