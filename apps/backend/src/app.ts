import "@workflow/demo-workflow";
import type { QueueEvent, RunState } from "@workflow/core";
import { createRemoteRuntimeServer } from "@workflow/remote";
import type {
  QueueItem,
  QueueItemStatus,
  QueueSnapshot,
  RunEvent,
  SaveResult,
  SecretResolver,
  StoredRunState,
} from "@workflow/runtime";
import { RuntimeExecutor } from "@workflow/runtime";
import type {
  BindRunSecretRequest,
  CreateSecretVaultEntryRequest,
  RunSecretBinding,
  SecretVaultEntry,
  SetWorkflowAutoAdvanceRequest,
  StartWorkflowRunRequest,
  SubmitWorkflowInputRequest,
  UpdateSecretVaultEntryRequest,
} from "@workflow/server";
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
const DEFAULT_ORGANIZATION_ID = "org_personal_dev";
const DEFAULT_USER_ID = "user_dev";
const SECRET_BOUND_PAYLOAD = "[bound]";

type StoredSecretVaultEntry = SecretVaultEntry & {
  ciphertext: string;
};

export function createApp(
  storage: DurableObjectStorage,
  workerLoader: WorkerLoader,
) {
  const stateStore = new DurableObjectWorkflowStateStore(storage);
  const queue = new DurableObjectWorkflowQueue(storage);
  const secretResolver: SecretResolver = {
    resolve: ({ workflow, state, logicalName }) =>
      resolveBoundSecret(storage, {
        runId: state.runId,
        workflowId: workflow.workflowId,
        organizationId: workflow.organizationId ?? DEFAULT_ORGANIZATION_ID,
        logicalName,
      }),
  };
  const staticManager = new WorkflowManager({
    workflows: {},
    stateStore,
    queue,
    executor: new RuntimeExecutor(secretResolver),
    workflow: {
      id: WORKFLOW_ID,
      organizationId: DEFAULT_ORGANIZATION_ID,
      name: WORKFLOW_NAME,
    },
  });
  const dynamicExecutor = new DynamicWorkerExecutor(
    workerLoader,
    (workflowId) => loadWorkflow(storage, workflowId),
    secretResolver,
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

  app.route(
    "/runtime",
    createRemoteRuntimeServer({
      basePath: "/",
      stateStore,
      queue,
    }),
  );

  app.get("/vault/secrets", async (c) =>
    c.json(await listSecretVaultEntries(storage, DEFAULT_ORGANIZATION_ID)),
  );

  app.post("/vault/secrets", async (c) => {
    try {
      const body = (await readBody(c.req)) as CreateSecretVaultEntryRequest;
      return c.json(
        publicVaultEntry(
          await createSecretVaultEntry(storage, {
            organizationId: DEFAULT_ORGANIZATION_ID,
            ownerUserId: DEFAULT_USER_ID,
            body,
          }),
        ),
      );
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  app.patch("/vault/secrets/:secretId", async (c) => {
    try {
      const secretId = c.req.param("secretId");
      const body = (await readBody(c.req)) as UpdateSecretVaultEntryRequest;
      const updated = await updateSecretVaultEntry(storage, secretId, body);
      if (!updated) return c.json({ message: "Unknown secret" }, 404);
      return c.json(publicVaultEntry(updated));
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  app.delete("/vault/secrets/:secretId", async (c) => {
    const secretId = c.req.param("secretId");
    await storage.delete(secretVaultEntryKey(secretId));
    return c.json({ ok: true as const });
  });

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
        organizationId: DEFAULT_ORGANIZATION_ID,
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
      const workflow = await loadWorkflow(storage, workflowId);
      if (!manager || !workflow)
        return c.json({ message: "Unknown workflow" }, 404);
      const body = await readBody(c.req);
      const runId = stringValue(body, "runId") ?? `run_${randomId()}`;
      await saveInitialSecretBindings(storage, {
        workflowId,
        organizationId: workflow.organizationId ?? DEFAULT_ORGANIZATION_ID,
        runId,
        secretBindings: secretBindingsValue(body),
      });
      return c.json(
        await manager.startRun({ ...body, runId } as StartWorkflowRunRequest),
      );
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  app.post("/runs", async (c) => {
    try {
      const manager = (await managerForWorkflow(WORKFLOW_ID)) ?? staticManager;
      const body = await readBody(c.req);
      const runId = stringValue(body, "runId") ?? `run_${randomId()}`;
      await saveInitialSecretBindings(storage, {
        workflowId: WORKFLOW_ID,
        organizationId: DEFAULT_ORGANIZATION_ID,
        runId,
        secretBindings: secretBindingsValue(body),
      });
      return c.json(
        await manager.startRun({ ...body, runId } as StartWorkflowRunRequest),
      );
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  app.get("/runs/:runId", async (c) => runDocument(c, stateStore));
  app.get("/state/:runId", async (c) => runDocument(c, stateStore));

  app.get("/runs/:runId/secret-bindings", async (c) => {
    const document = await stateStore.getRunDocument(c.req.param("runId"));
    if (!document) return c.json({ message: "Unknown run" }, 404);
    return c.json(await listRunSecretBindings(storage, document.runId));
  });

  app.put("/runs/:runId/secret-bindings/:logicalName", async (c) => {
    try {
      return c.json(
        await bindRunSecretAndWake(
          c.req.param("runId"),
          c.req.param("logicalName"),
          await readBody(c.req),
        ),
      );
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  app.get("/workflows/:workflowId/runs/:runId/secret-bindings", async (c) => {
    const document = await stateStore.getRunDocument(c.req.param("runId"));
    if (
      !document ||
      document.workflow.workflowId !== c.req.param("workflowId")
    ) {
      return c.json({ message: "Unknown run" }, 404);
    }
    return c.json(await listRunSecretBindings(storage, document.runId));
  });

  app.put(
    "/workflows/:workflowId/runs/:runId/secret-bindings/:logicalName",
    async (c) => {
      try {
        const document = await stateStore.getRunDocument(c.req.param("runId"));
        if (
          !document ||
          document.workflow.workflowId !== c.req.param("workflowId")
        ) {
          return c.json({ message: "Unknown run" }, 404);
        }
        return c.json(
          await bindRunSecretAndWake(
            c.req.param("runId"),
            c.req.param("logicalName"),
            await readBody(c.req),
          ),
        );
      } catch (e) {
        return errorResponse(c, e);
      }
    },
  );

  app.post("/runs/:runId/inputs", async (c) => {
    try {
      const manager = await managerForRun(c.req.param("runId"));
      return c.json(
        await manager.submitInput(
          c.req.param("runId"),
          (await readBody(c.req)) as SubmitWorkflowInputRequest,
        ),
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
          (await readBody(c.req)) as SetWorkflowAutoAdvanceRequest,
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
        organizationId: workflow.organizationId ?? DEFAULT_ORGANIZATION_ID,
        name: workflow.name,
        version: workflow.manifest.version,
        codeHash: workflow.manifest.codeHash,
      },
    });
  }

  async function bindRunSecretAndWake(
    runId: string,
    logicalName: string,
    body: unknown,
  ): Promise<WorkflowRunDocument> {
    const document = await stateStore.getRunDocument(runId);
    if (!document) throw new Error(`Unknown run: ${runId}`);
    const request = body as BindRunSecretRequest;
    if (!request || typeof request.vaultEntryId !== "string") {
      throw new Error("Missing vaultEntryId");
    }

    await saveRunSecretBinding(storage, {
      runId,
      workflowId: document.workflow.workflowId,
      organizationId:
        document.workflow.organizationId ?? DEFAULT_ORGANIZATION_ID,
      logicalName,
      vaultEntryId: request.vaultEntryId,
      boundByUserId: DEFAULT_USER_ID,
    });

    const manager = await managerForRun(runId);
    return manager.submitInput(runId, {
      inputId: logicalName,
      payload: SECRET_BOUND_PAYLOAD,
      autoAdvance: request.autoAdvance ?? document.autoAdvance,
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

async function createSecretVaultEntry(
  storage: DurableObjectStorage,
  args: {
    organizationId: string;
    ownerUserId: string;
    body: CreateSecretVaultEntryRequest;
  },
): Promise<StoredSecretVaultEntry> {
  if (!args.body || typeof args.body.name !== "string" || !args.body.name) {
    throw new Error("Missing secret name");
  }
  if (typeof args.body.value !== "string" || !args.body.value) {
    throw new Error("Missing secret value");
  }

  const now = Date.now();
  const entry: StoredSecretVaultEntry = {
    id: `vault_secret_${randomId()}`,
    organizationId: args.organizationId,
    ownerUserId:
      args.body.scope === "organization" ? undefined : args.ownerUserId,
    scope: args.body.scope ?? "user",
    name: args.body.name,
    key: args.body.key,
    ciphertext: await encryptSecret(args.body.value),
    createdAt: now,
    updatedAt: now,
  };
  await storage.put(secretVaultEntryKey(entry.id), entry);
  return entry;
}

async function updateSecretVaultEntry(
  storage: DurableObjectStorage,
  secretId: string,
  body: UpdateSecretVaultEntryRequest,
): Promise<StoredSecretVaultEntry | undefined> {
  const current = await storage.get<StoredSecretVaultEntry>(
    secretVaultEntryKey(secretId),
  );
  if (!current) return undefined;

  const next: StoredSecretVaultEntry = {
    ...current,
    name: typeof body.name === "string" && body.name ? body.name : current.name,
    key: typeof body.key === "string" ? body.key : current.key,
    scope: body.scope ?? current.scope,
    ownerUserId:
      body.scope === "organization" ? undefined : current.ownerUserId,
    ciphertext:
      typeof body.value === "string" && body.value
        ? await encryptSecret(body.value)
        : current.ciphertext,
    updatedAt: Date.now(),
  };
  await storage.put(secretVaultEntryKey(secretId), next);
  return next;
}

async function listSecretVaultEntries(
  storage: DurableObjectStorage,
  organizationId: string,
): Promise<SecretVaultEntry[]> {
  const rows = await storage.list<StoredSecretVaultEntry>({
    prefix: secretVaultEntryPrefix(),
  });
  return [...rows.values()]
    .filter((entry) => entry.organizationId === organizationId)
    .map(publicVaultEntry)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function publicVaultEntry(entry: StoredSecretVaultEntry): SecretVaultEntry {
  const { ciphertext: _ciphertext, ...publicEntry } = entry;
  return publicEntry;
}

async function saveInitialSecretBindings(
  storage: DurableObjectStorage,
  args: {
    workflowId: string;
    organizationId: string;
    runId: string;
    secretBindings: Record<string, string> | undefined;
  },
): Promise<void> {
  if (!args.secretBindings) return;
  for (const [logicalName, vaultEntryId] of Object.entries(
    args.secretBindings,
  )) {
    await saveRunSecretBinding(storage, {
      runId: args.runId,
      workflowId: args.workflowId,
      organizationId: args.organizationId,
      logicalName,
      vaultEntryId,
      boundByUserId: DEFAULT_USER_ID,
    });
  }
}

async function saveRunSecretBinding(
  storage: DurableObjectStorage,
  args: Omit<RunSecretBinding, "createdAt">,
): Promise<RunSecretBinding> {
  const entry = await storage.get<StoredSecretVaultEntry>(
    secretVaultEntryKey(args.vaultEntryId),
  );
  if (!entry) throw new Error(`Unknown vault secret: ${args.vaultEntryId}`);
  if (entry.organizationId !== args.organizationId) {
    throw new Error("Vault secret belongs to a different organization");
  }

  const binding: RunSecretBinding = {
    ...args,
    createdAt: Date.now(),
  };
  await storage.put(runSecretBindingKey(args.runId, args.logicalName), binding);
  return binding;
}

async function listRunSecretBindings(
  storage: DurableObjectStorage,
  runId: string,
): Promise<RunSecretBinding[]> {
  const rows = await storage.list<RunSecretBinding>({
    prefix: runSecretBindingPrefix(runId),
  });
  return [...rows.values()].sort((a, b) => a.createdAt - b.createdAt);
}

async function resolveBoundSecret(
  storage: DurableObjectStorage,
  args: {
    runId: string;
    workflowId: string;
    organizationId: string;
    logicalName: string;
  },
): Promise<string | undefined> {
  const binding = await storage.get<RunSecretBinding>(
    runSecretBindingKey(args.runId, args.logicalName),
  );
  if (!binding) return undefined;
  if (
    binding.workflowId !== args.workflowId ||
    binding.organizationId !== args.organizationId
  ) {
    return undefined;
  }

  const entry = await storage.get<StoredSecretVaultEntry>(
    secretVaultEntryKey(binding.vaultEntryId),
  );
  if (!entry || entry.organizationId !== args.organizationId) {
    return undefined;
  }

  await storage.put<StoredSecretVaultEntry>(secretVaultEntryKey(entry.id), {
    ...entry,
    lastUsedAt: Date.now(),
  });
  return decryptSecret(entry.ciphertext);
}

async function readBody(req: {
  json(): Promise<unknown>;
}): Promise<Record<string, unknown>> {
  try {
    const value = await req.json();
    return value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
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

function secretBindingsValue(
  value: unknown,
): Record<string, string> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = (value as Record<string, unknown>).secretBindings;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;

  const bindings: Record<string, string> = {};
  for (const [logicalName, binding] of Object.entries(raw)) {
    if (typeof binding === "string") {
      bindings[logicalName] = binding;
      continue;
    }
    if (binding && typeof binding === "object") {
      const vaultEntryId = (binding as Record<string, unknown>).vaultEntryId;
      if (typeof vaultEntryId === "string")
        bindings[logicalName] = vaultEntryId;
    }
  }
  return Object.keys(bindings).length > 0 ? bindings : undefined;
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
    (workflow.organizationId === undefined ||
      typeof workflow.organizationId === "string") &&
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

function secretVaultEntryPrefix(): string {
  return "secret-vault-entry:";
}

function secretVaultEntryKey(secretId: string): string {
  return `${secretVaultEntryPrefix()}${secretId}`;
}

function runSecretBindingPrefix(runId: string): string {
  return `run-secret-binding:${runId}:`;
}

function runSecretBindingKey(runId: string, logicalName: string): string {
  return `${runSecretBindingPrefix(runId)}${encodeURIComponent(logicalName)}`;
}

let cachedVaultKey: Promise<CryptoKey> | undefined;

async function vaultKey(): Promise<CryptoKey> {
  cachedVaultKey ??= crypto.subtle.importKey(
    "raw",
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode("hylo-local-dev-secret-vault-key"),
    ),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
  return cachedVaultKey;
}

async function encryptSecret(value: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await vaultKey(),
    new TextEncoder().encode(value),
  );
  return `${base64Encode(iv)}.${base64Encode(new Uint8Array(ciphertext))}`;
}

async function decryptSecret(ciphertext: string): Promise<string> {
  const [encodedIv, encodedValue] = ciphertext.split(".");
  if (!encodedIv || !encodedValue) throw new Error("Invalid secret ciphertext");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64Decode(encodedIv) },
    await vaultKey(),
    base64Decode(encodedValue),
  );
  return new TextDecoder().decode(plaintext);
}

function base64Encode(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64Decode(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array<ArrayBuffer>(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function randomId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)
  );
}

export type AppType = ReturnType<typeof createApp>;
