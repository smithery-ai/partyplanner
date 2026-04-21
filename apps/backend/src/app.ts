import type { QueueEvent, RunState } from "@workflow/core";
import {
  createRemoteRuntimeServer,
  mountRemoteRuntimeOpenApi,
} from "@workflow/remote";
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
import { Hono } from "hono";
import { cors } from "hono/cors";

export function createApp(storage: DurableObjectStorage) {
  const stateStore = new DurableObjectWorkflowStateStore(storage);
  const queue = new DurableObjectWorkflowQueue(storage);
  const app = new Hono();

  app.use(
    "/*",
    cors({
      origin: "*",
      allowHeaders: ["Content-Type"],
      allowMethods: ["GET", "PUT", "POST", "OPTIONS"],
    }),
  );
  app.get("/health", (c) => c.json({ ok: true }));
  mountRemoteRuntimeOpenApi(app, {
    title: "Hylo Backend Worker API",
    runtimeBasePath: "/runtime",
  });
  app.route(
    "/runtime",
    createRemoteRuntimeServer({
      basePath: "/",
      stateStore,
      queue,
      cors: false,
    }),
  );

  return app;
}

class DurableObjectWorkflowStateStore implements WorkflowStateStore {
  constructor(private readonly storage: DurableObjectStorage) {}

  async load(runId: string): Promise<StoredRunState | undefined> {
    return this.storage.get<StoredRunState>(runStateKey(runId));
  }

  async save(
    runId: string,
    state: RunState,
    expectedVersion?: number,
  ): Promise<SaveResult> {
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

    const version = (current?.version ?? 0) + 1;
    await this.storage.put<StoredRunState>(runStateKey(runId), {
      version,
      state,
    });
    return { ok: true, version };
  }

  publishEvent(event: RunEvent): Promise<void> {
    return this.publishEvents([event]);
  }

  async publishEvents(events: RunEvent[]): Promise<void> {
    await Promise.all(
      events.map((event) =>
        this.storage.put(eventKey(event.runId, event), event),
      ),
    );
  }

  async listEvents(runId: string): Promise<RunEvent[]> {
    const rows = await this.storage.list<RunEvent>({
      prefix: eventPrefix(runId),
    });
    return [...rows.values()].sort((a, b) => a.at - b.at);
  }

  async saveRunDocument(document: WorkflowRunDocument): Promise<void> {
    await this.storage.put(runDocumentKey(document.runId), document);
    await this.storage.put(
      runSummaryKey(document.runId),
      summarizeRun(document),
    );
  }

  getRunDocument(runId: string): Promise<WorkflowRunDocument | undefined> {
    return this.storage.get<WorkflowRunDocument>(runDocumentKey(runId));
  }

  async listRunSummaries(workflowId?: string): Promise<WorkflowRunSummary[]> {
    const rows = await this.storage.list<WorkflowRunSummary>({
      prefix: runSummaryPrefix(),
    });
    return [...rows.values()]
      .filter((summary) => !workflowId || summary.workflowId === workflowId)
      .sort(
        (a, b) => b.startedAt - a.startedAt || b.publishedAt - a.publishedAt,
      );
  }
}

class DurableObjectWorkflowQueue implements WorkflowQueue {
  constructor(private readonly storage: DurableObjectStorage) {}

  async enqueue(event: QueueEvent): Promise<void> {
    const key = queueKey(event.eventId);
    if (await this.storage.get<QueueItem>(key)) return;
    await this.storage.put<QueueItem>(key, {
      event,
      status: "pending",
      enqueuedAt: Date.now(),
    });
  }

  async enqueueMany(events: QueueEvent[]): Promise<void> {
    for (const event of events) await this.enqueue(event);
  }

  async claimNext(runId: string): Promise<QueueItem | undefined> {
    const item = (await this.items(runId))
      .filter((candidate) => candidate.status === "pending")
      .sort((a, b) => a.enqueuedAt - b.enqueuedAt)[0];
    if (!item) return undefined;

    const claimed: QueueItem = {
      ...item,
      status: "running",
      startedAt: Date.now(),
    };
    await this.storage.put(queueKey(item.event.eventId), claimed);
    return structuredClone(claimed);
  }

  async complete(eventId: string): Promise<void> {
    const item = await this.storage.get<QueueItem>(queueKey(eventId));
    if (!item) return;
    await this.storage.put<QueueItem>(queueKey(eventId), {
      ...item,
      status: "completed",
      finishedAt: Date.now(),
    });
  }

  async fail(eventId: string, error: Error): Promise<void> {
    const item = await this.storage.get<QueueItem>(queueKey(eventId));
    if (!item) return;
    await this.storage.put<QueueItem>(queueKey(eventId), {
      ...item,
      status: "failed",
      finishedAt: Date.now(),
      error: error.message,
    });
  }

  async snapshot(runId: string): Promise<QueueSnapshot> {
    const items = await this.items(runId);
    return {
      pending: filterQueue(items, "pending"),
      running: filterQueue(items, "running"),
      completed: filterQueue(items, "completed"),
      failed: filterQueue(items, "failed"),
    };
  }

  async size(runId: string): Promise<number> {
    return (await this.items(runId)).filter((item) => item.status === "pending")
      .length;
  }

  private async items(runId: string): Promise<QueueItem[]> {
    const rows = await this.storage.list<QueueItem>({ prefix: queuePrefix() });
    return [...rows.values()].filter((item) => item.event.runId === runId);
  }
}

function filterQueue(items: QueueItem[], status: QueueItemStatus): QueueItem[] {
  return items.filter((item) => item.status === status);
}

function runStateKey(runId: string): string {
  return `run-state:${runId}`;
}

function eventPrefix(runId: string): string {
  return `run-event:${runId}:`;
}

function eventKey(runId: string, event: RunEvent): string {
  return `${eventPrefix(runId)}${event.at}:${randomId()}`;
}

function runDocumentKey(runId: string): string {
  return `run-document:${runId}`;
}

function runSummaryPrefix(): string {
  return "run-summary:";
}

function runSummaryKey(runId: string): string {
  return `${runSummaryPrefix()}${runId}`;
}

function queuePrefix(): string {
  return "queue:";
}

function queueKey(eventId: string): string {
  return `${queuePrefix()}${eventId}`;
}

function randomId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)
  );
}

export type AppType = ReturnType<typeof createApp>;
