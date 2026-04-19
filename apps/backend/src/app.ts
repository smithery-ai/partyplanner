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
import {
  createStoredDynamicWorkflow,
  DynamicWorkerExecutor,
  registryFromStoredWorkflow,
  type StoredWorkflow,
} from "./dynamic-worker";

const WORKFLOW_ID = "default";
const WORKFLOW_NAME = "Onboarding demo";

export function createApp(
  storage: DurableObjectStorage,
  workerLoader: WorkerLoader,
) {
  const stateStore = new DurableObjectWorkflowStateStore(storage);
  const queue = new DurableObjectWorkflowQueue(storage);
  const staticManager = new WorkflowManager({
    workflows: {},
    stateStore,
    queue,
    workflow: {
      id: WORKFLOW_ID,
      name: WORKFLOW_NAME,
    },
  });
  const dynamicExecutor = new DynamicWorkerExecutor(
    workerLoader,
    (workflowId) => loadWorkflow(storage, workflowId),
  );

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
    return c.json(
      (await listWorkflows(storage))
        .map((workflow) => workflow.manifest)
        .sort((a, b) => b.createdAt - a.createdAt),
    );
  });

  app.post("/workflows", async (c) => {
    try {
      const body = await readBody(c.req);
      const source = stringValue(body, "workflowSource");
      if (!source) return c.json({ message: "Missing workflowSource" }, 400);

      const workflowId =
        stringValue(body, "workflowId") ?? `workflow_${randomId()}`;
      if (await loadWorkflow(storage, workflowId)) {
        return c.json(
          { message: `Workflow already exists: ${workflowId}` },
          400,
        );
      }

      const workflow = await createStoredDynamicWorkflow(workerLoader, {
        workflowId,
        name: stringValue(body, "name"),
        source,
      });
      await storage.put<StoredWorkflow>(workflowKey(workflowId), workflow);
      return c.json(workflow.manifest);
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  app.get("/workflows/:workflowId", async (c) => {
    const workflowId = c.req.param("workflowId");
    const workflow = await loadWorkflow(storage, workflowId);
    if (!workflow) return c.json({ message: "Unknown workflow" }, 404);
    return c.json(workflow.manifest);
  });

  app.delete("/workflows/:workflowId", async (c) => {
    const workflowId = c.req.param("workflowId");
    if (!(await loadWorkflow(storage, workflowId))) {
      return c.json({ message: "Unknown workflow" }, 404);
    }
    await deleteWorkflow(storage, workflowId);
    return c.json({ ok: true as const });
  });

  app.get("/runs", async (c) => c.json(await stateStore.listRunSummaries()));

  app.get("/workflows/:workflowId/runs", async (c) => {
    const workflowId = c.req.param("workflowId");
    if (!(await managerForWorkflow(workflowId))) {
      return c.json({ message: "Unknown workflow" }, 404);
    }
    return c.json(await stateStore.listRunSummaries(workflowId));
  });

  app.post("/workflows/:workflowId/runs", async (c) => {
    try {
      const workflowId = c.req.param("workflowId");
      const manager = await managerForWorkflow(workflowId);
      if (!manager || !(await loadWorkflow(storage, workflowId)))
        return c.json({ message: "Unknown workflow" }, 404);
      return c.json(await manager.startRun(await readBody(c.req)));
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  app.post("/runs", async (c) => {
    try {
      const manager = (await managerForWorkflow(WORKFLOW_ID)) ?? staticManager;
      return c.json(await manager.startRun(await readBody(c.req)));
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  app.get("/runs/:runId", async (c) => runDocument(c, stateStore));
  app.get("/state/:runId", async (c) => runDocument(c, stateStore));

  app.post("/runs/:runId/inputs", async (c) => {
    try {
      const manager = await managerForRun(c.req.param("runId"));
      return c.json(
        await manager.submitInput(c.req.param("runId"), await readBody(c.req)),
      );
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  app.post("/runs/:runId/advance", async (c) => {
    try {
      const manager = await managerForRun(c.req.param("runId"));
      return c.json(await manager.advanceRun(c.req.param("runId")));
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  app.post("/runs/:runId/auto-advance", async (c) => {
    try {
      const manager = await managerForRun(c.req.param("runId"));
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

  async function managerForRun(runId: string): Promise<WorkflowManager> {
    const document = await stateStore.getRunDocument(runId);
    if (!document) throw new Error(`Unknown run: ${runId}`);
    const manager = await managerForWorkflow(document.workflow.workflowId);
    if (!manager)
      throw new Error(`Unknown workflow: ${document.workflow.workflowId}`);
    return manager;
  }

  async function managerForWorkflow(
    workflowId: string,
  ): Promise<WorkflowManager | undefined> {
    const workflow = await loadWorkflow(storage, workflowId);
    if (!workflow) {
      return workflowId === WORKFLOW_ID ? staticManager : undefined;
    }
    return new WorkflowManager({
      workflows: {},
      stateStore,
      queue,
      registry: registryFromStoredWorkflow(workflow),
      executor: dynamicExecutor,
      workflow: {
        id: workflow.workflowId,
        name: workflow.name,
        version: workflow.manifest.version,
        codeHash: workflow.manifest.codeHash,
      },
    });
  }
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

function workflowPrefix(): string {
  return "workflow:";
}

function workflowKey(workflowId: string): string {
  return `${workflowPrefix()}${workflowId}`;
}

async function loadWorkflow(
  storage: DurableObjectStorage,
  workflowId: string,
): Promise<StoredWorkflow | undefined> {
  const value = await storage.get<unknown>(workflowKey(workflowId));
  return isStoredWorkflow(value) ? value : undefined;
}

async function listWorkflows(
  storage: DurableObjectStorage,
): Promise<StoredWorkflow[]> {
  const rows = await storage.list<StoredWorkflow>({ prefix: workflowPrefix() });
  return [...rows.values()].filter(isStoredWorkflow);
}

function isStoredWorkflow(value: unknown): value is StoredWorkflow {
  if (!value || typeof value !== "object") return false;
  const workflow = value as Partial<StoredWorkflow>;
  return (
    typeof workflow.workflowId === "string" &&
    typeof workflow.source === "string" &&
    Boolean(workflow.manifest) &&
    Array.isArray(workflow.atoms)
  );
}

async function deleteWorkflow(
  storage: DurableObjectStorage,
  workflowId: string,
): Promise<void> {
  const summaries = await storage.list<WorkflowRunSummary>({
    prefix: runSummaryPrefix(),
  });
  const runIds = [...summaries.values()]
    .filter((summary) => summary.workflowId === workflowId)
    .map((summary) => summary.runId);

  await Promise.all([
    storage.delete(workflowKey(workflowId)),
    ...runIds.flatMap((runId) => deleteRun(storage, runId)),
  ]);
}

function deleteRun(
  storage: DurableObjectStorage,
  runId: string,
): Promise<boolean>[] {
  return [
    storage.delete(runStateKey(runId)),
    storage.delete(runDocumentKey(runId)),
    storage.delete(runSummaryKey(runId)),
    deleteByPrefix(storage, eventPrefix(runId)),
    deleteQueueItems(storage, runId),
  ];
}

async function deleteByPrefix(
  storage: DurableObjectStorage,
  prefix: string,
): Promise<boolean> {
  const rows = await storage.list({ prefix });
  await Promise.all([...rows.keys()].map((key) => storage.delete(key)));
  return true;
}

async function deleteQueueItems(
  storage: DurableObjectStorage,
  runId: string,
): Promise<boolean> {
  const rows = await storage.list<QueueItem>({ prefix: queuePrefix() });
  await Promise.all(
    [...rows.entries()]
      .filter(([, item]) => item.event.runId === runId)
      .map(([key]) => storage.delete(key)),
  );
  return true;
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
