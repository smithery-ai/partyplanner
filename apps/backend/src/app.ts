import "@workflow/demo-workflow";
import type { QueueEvent, RunState } from "@workflow/core";
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
  WorkflowManager,
  type WorkflowQueue,
  type WorkflowRunDocument,
  type WorkflowRunSummary,
  type WorkflowStateStore,
} from "@workflow/server";
import { Hono } from "hono";
import { cors } from "hono/cors";

const WORKFLOW_ID = "default";
const WORKFLOW_NAME = "Onboarding demo";
const WORKFLOW_SOURCE = "bundled-default";

export function createApp(storage: DurableObjectStorage) {
  const stateStore = new DurableObjectWorkflowStateStore(storage);
  const queue = new DurableObjectWorkflowQueue(storage);
  const manager = new WorkflowManager({
    workflows: {},
    stateStore,
    queue,
    workflow: {
      id: WORKFLOW_ID,
      name: WORKFLOW_NAME,
    },
  });
  const manifest = {
    ...manager.manifest(),
    source: WORKFLOW_SOURCE,
  };

  const app = new Hono();
  app.use(
    "/*",
    cors({
      origin: "*",
      allowHeaders: ["Content-Type"],
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    }),
  );

  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/workflows", async (c) => {
    if (!(await workflowExists(storage))) return c.json([]);
    return c.json([await workflowManifest(storage, manifest)]);
  });

  app.post("/workflows", async (c) => {
    const body = await readBody(c.req);
    const requestedId = stringValue(body, "workflowId") ?? WORKFLOW_ID;
    if (requestedId !== WORKFLOW_ID) {
      return c.json(
        {
          message:
            "The Cloudflare Worker backend currently supports the bundled default workflow only.",
        },
        400,
      );
    }

    await storage.put<StoredWorkflow>(workflowKey(), {
      createdAt: Date.now(),
      name: stringValue(body, "name") ?? WORKFLOW_NAME,
      source: stringValue(body, "workflowSource") ?? WORKFLOW_SOURCE,
    });

    return c.json(await workflowManifest(storage, manifest));
  });

  app.get("/workflows/:workflowId", async (c) => {
    const workflowId = c.req.param("workflowId");
    if (workflowId !== WORKFLOW_ID || !(await workflowExists(storage))) {
      return c.json({ message: "Unknown workflow" }, 404);
    }
    return c.json(await workflowManifest(storage, manifest));
  });

  app.delete("/workflows/:workflowId", async (c) => {
    const workflowId = c.req.param("workflowId");
    if (workflowId !== WORKFLOW_ID || !(await workflowExists(storage))) {
      return c.json({ message: "Unknown workflow" }, 404);
    }

    await clearWorkflow(storage);
    return c.json({ ok: true as const });
  });

  app.get("/runs", async (c) => c.json(await stateStore.listRunSummaries()));

  app.post("/workflows/:workflowId/runs", async (c) => {
    try {
      const workflowId = c.req.param("workflowId");
      if (workflowId !== WORKFLOW_ID || !(await workflowExists(storage))) {
        return c.json({ message: "Unknown workflow" }, 404);
      }
      return c.json(await manager.startRun(await readBody(c.req)));
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  app.post("/runs", async (c) => {
    try {
      await ensureWorkflow(storage);
      return c.json(await manager.startRun(await readBody(c.req)));
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  app.get("/runs/:runId", async (c) => runDocument(c, stateStore));
  app.get("/state/:runId", async (c) => runDocument(c, stateStore));

  app.post("/runs/:runId/inputs", async (c) => {
    try {
      return c.json(
        await manager.submitInput(c.req.param("runId"), await readBody(c.req)),
      );
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  app.post("/runs/:runId/advance", async (c) => {
    try {
      return c.json(await manager.advanceRun(c.req.param("runId")));
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  app.post("/runs/:runId/auto-advance", async (c) => {
    try {
      return c.json(
        await manager.setAutoAdvance(
          c.req.param("runId"),
          await readBody(c.req),
        ),
      );
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  return app;
}

async function runDocument(
  c: {
    req: { param(name: string): string };
    json(body: unknown, status?: number): Response;
  },
  stateStore: DurableObjectWorkflowStateStore,
): Promise<Response> {
  const document = await stateStore.getRunDocument(c.req.param("runId"));
  if (!document) return c.json({ message: "Unknown run" }, 404);
  return c.json(document);
}

async function readBody(req: { json(): Promise<unknown> }): Promise<never> {
  try {
    return (await req.json()) as never;
  } catch {
    return {} as never;
  }
}

function errorResponse(
  c: { json(body: { message: string }, status: 400): Response },
  error: unknown,
): Response {
  const message = error instanceof Error ? error.message : String(error);
  return c.json({ message }, 400);
}

function stringValue(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : undefined;
}

type StoredWorkflow = {
  createdAt: number;
  name: string;
  source: string;
};

function workflowKey(): string {
  return "workflow:default";
}

async function workflowExists(storage: DurableObjectStorage): Promise<boolean> {
  return Boolean(await storage.get<StoredWorkflow>(workflowKey()));
}

async function ensureWorkflow(storage: DurableObjectStorage): Promise<void> {
  if (await workflowExists(storage)) return;
  await storage.put<StoredWorkflow>(workflowKey(), {
    createdAt: Date.now(),
    name: WORKFLOW_NAME,
    source: WORKFLOW_SOURCE,
  });
}

async function workflowManifest(
  storage: DurableObjectStorage,
  manifest: ReturnType<WorkflowManager["manifest"]> & { source: string },
) {
  const stored = await storage.get<StoredWorkflow>(workflowKey());
  return {
    ...manifest,
    name: stored?.name ?? manifest.name,
    source: stored?.source ?? manifest.source,
    createdAt: stored?.createdAt ?? manifest.createdAt,
  };
}

async function clearWorkflow(storage: DurableObjectStorage): Promise<void> {
  const keys = await storage.list();
  await Promise.all([...keys.keys()].map((key) => storage.delete(key)));
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

  async listRunSummaries(): Promise<WorkflowRunSummary[]> {
    const rows = await this.storage.list<WorkflowRunSummary>({
      prefix: runSummaryPrefix(),
    });
    return [...rows.values()].sort(
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
