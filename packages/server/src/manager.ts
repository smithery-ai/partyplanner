import { globalRegistry, Registry } from "@workflow/core";
import {
  type Executor,
  type InspectableWorkQueue,
  LocalScheduler,
  type QueueItem,
  type QueueSnapshot,
  type RunEvent,
  type RunSnapshot,
  RuntimeExecutor,
  type SecretResolver,
  StaticWorkflowLoader,
  type WorkflowRef,
} from "@workflow/runtime";
import { buildWorkflowManifest, type WorkflowManifest } from "./manifest";
import type {
  StartWorkflowRunRequest,
  SubmitWorkflowInputRequest,
  SubmitWorkflowInterventionRequest,
  SubmitWorkflowWebhookRequest,
  WorkflowEventSink,
  WorkflowQueue,
  WorkflowRunDocument,
  WorkflowRunSummary,
  WorkflowServerDefinition,
  WorkflowStateStore,
} from "./types";

export type WorkflowManagerOptions = {
  stateStore: WorkflowStateStore;
  queue: WorkflowQueue;
  registry?: Registry;
  executor?: Executor;
  workflow?: {
    id?: string;
    organizationId?: string;
    version?: string;
    codeHash?: string;
    name?: string;
  };
};

const WEBHOOK_PAYLOAD_NODE_ID = "@workflow/webhook-payload";

export type WorkflowWebhookRequestContext = {
  method: string;
  url: string;
  route: string;
  headers: Record<string, string>;
  query: Record<string, string>;
};

export class WorkflowManager {
  readonly definition: WorkflowServerDefinition;
  private readonly registry: Registry;
  private readonly stateStore: WorkflowStateStore;
  private readonly queue: WorkflowQueue;
  private readonly executor: Executor;

  constructor(options: WorkflowManagerOptions) {
    this.stateStore = options.stateStore;
    this.queue = options.queue;
    this.executor = options.executor ?? new RuntimeExecutor();

    const registry = cloneRegistry(options.registry ?? globalRegistry);
    this.registry = registry;
    const codeHash = options.workflow?.codeHash ?? hashRegistry(registry);
    const workflow: WorkflowRef = {
      workflowId: options.workflow?.id ?? "workflow",
      organizationId: options.workflow?.organizationId,
      version: options.workflow?.version ?? codeHash,
      codeHash,
    };
    this.definition = {
      ref: workflow,
      manifest: buildWorkflowManifest({
        workflowId: workflow.workflowId,
        organizationId: workflow.organizationId,
        version: workflow.version,
        codeHash,
        name: options.workflow?.name,
        createdAt: Date.now(),
        registry,
      }),
    };

    this.loader = new StaticWorkflowLoader([
      {
        ref: workflow,
        registry,
      },
    ]);
  }

  private readonly loader: StaticWorkflowLoader;

  manifest(): WorkflowManifest {
    return structuredClone(this.definition.manifest);
  }

  listRuns(): Promise<WorkflowRunSummary[]> {
    return this.stateStore.listRunSummaries(this.definition.ref.workflowId);
  }

  getRun(runId: string): Promise<WorkflowRunDocument | undefined> {
    return this.stateStore.getRunDocument(runId);
  }

  async startRun(
    request: StartWorkflowRunRequest,
  ): Promise<WorkflowRunDocument> {
    const runId = request.runId ?? `run_${randomId()}`;
    const scheduler = this.createScheduler(runId, request.secretValues);
    const snapshot = await scheduler.startRun({
      workflow: this.definition.ref,
      runId,
      input: {
        inputId: request.inputId,
        payload: request.payload,
      },
      additionalInputs: request.additionalInputs,
    });
    return this.publishSnapshot(snapshot);
  }

  async submitInput(
    runId: string,
    request: SubmitWorkflowInputRequest,
  ): Promise<WorkflowRunDocument> {
    const scheduler = this.createScheduler(runId, request.secretValues);
    const snapshot = await scheduler.submitInput({
      runId,
      workflow: this.definition.ref,
      inputId: request.inputId,
      payload: request.payload,
    });
    return this.publishSnapshot(snapshot);
  }

  async submitWebhook(
    request: SubmitWorkflowWebhookRequest,
    requestContext?: WorkflowWebhookRequestContext,
  ): Promise<WorkflowRunDocument> {
    const runId = request.runId ?? `run_${randomId()}`;
    const existing = await this.stateStore.getRunDocument(runId);
    if (
      existing &&
      existing.status !== "created" &&
      existing.status !== "waiting"
    ) {
      throw new Error(
        `Webhook payloads can only be submitted to created or waiting runs. Current status: ${existing.status}`,
      );
    }

    const scheduler = this.createScheduler(runId);
    const baseSnapshot = await scheduler.startRun({
      workflow: this.definition.ref,
      runId,
    });
    const at = Date.now();
    await this.stateStore.publishEvent({ type: "webhook_received", runId, at });

    let snapshot = baseSnapshot;
    {
      const state = structuredClone(snapshot.state);
      if (state.payload === undefined) state.payload = request.payload;
      const previousWebhookNode = state.nodes[WEBHOOK_PAYLOAD_NODE_ID];
      state.webhook = {
        nodeId: WEBHOOK_PAYLOAD_NODE_ID,
        matchedInputs: [],
        receivedAt: at,
      };
      state.nodes[WEBHOOK_PAYLOAD_NODE_ID] = {
        status: "resolved",
        kind: "webhook",
        value: webhookRequestValue(request, requestContext, at),
        deps: [],
        duration_ms: 0,
        attempts: (previousWebhookNode?.attempts ?? 0) + 1,
      };
      const saved = await this.stateStore.save(runId, state, snapshot.version);
      if (!saved.ok) {
        throw new Error(`Unable to save run: ${saved.reason}`);
      }
      snapshot = await scheduler.snapshot(runId);
    }

    const matches = this.matchWebhookInputs(snapshot.state, request.payload);
    if (matches.length === 0) {
      const state = structuredClone(snapshot.state);
      state.webhook = {
        ...(state.webhook ?? {
          nodeId: WEBHOOK_PAYLOAD_NODE_ID,
          receivedAt: at,
        }),
        matchedInputs: [],
      };
      state.nodes[WEBHOOK_PAYLOAD_NODE_ID] = {
        ...(state.nodes[WEBHOOK_PAYLOAD_NODE_ID] ?? {
          kind: "webhook",
          deps: [],
          duration_ms: 0,
          attempts: 1,
        }),
        status: "errored",
        error: {
          message:
            "No unresolved workflow input matched the received webhook payload.",
        },
      };
      state.terminal = {
        status: "failed",
        reason: "webhook_unmatched",
      };
      const saved = await this.stateStore.save(runId, state, snapshot.version);
      if (!saved.ok) {
        throw new Error(`Unable to save run: ${saved.reason}`);
      }
      await this.stateStore.publishEvents([
        {
          type: "webhook_unmatched",
          runId,
          reason:
            "No unresolved workflow input matched the received webhook payload.",
          at: Date.now(),
        },
        {
          type: "run_failed",
          runId,
          reason: "webhook_unmatched",
          at: Date.now(),
        },
      ]);
      return this.publishSnapshot(await scheduler.snapshot(runId));
    }

    await this.stateStore.publishEvents(
      matches.map((input) => ({
        type: "webhook_matched" as const,
        runId,
        inputId: input.id,
        at: Date.now(),
      })),
    );

    {
      const state = structuredClone(snapshot.state);
      state.webhook = {
        nodeId: WEBHOOK_PAYLOAD_NODE_ID,
        matchedInputs: matches.map((input) => input.id),
        receivedAt: at,
      };
      const saved = await this.stateStore.save(runId, state, snapshot.version);
      if (!saved.ok) {
        throw new Error(`Unable to save run: ${saved.reason}`);
      }
      snapshot = await scheduler.snapshot(runId);
    }

    for (const input of matches) {
      snapshot = await scheduler.submitInput({
        runId,
        workflow: this.definition.ref,
        inputId: input.id,
        payload: request.payload,
      });
    }
    return this.publishSnapshot(snapshot);
  }

  async submitIntervention(
    runId: string,
    interventionId: string,
    request: SubmitWorkflowInterventionRequest,
  ): Promise<WorkflowRunDocument> {
    const scheduler = this.createScheduler(runId, request.secretValues);
    const snapshot = await scheduler.submitIntervention({
      runId,
      workflow: this.definition.ref,
      interventionId,
      payload: request.payload,
    });
    return this.publishSnapshot(snapshot);
  }

  async advanceRun(
    runId: string,
    request: { secretValues?: Record<string, string> } = {},
  ): Promise<WorkflowRunDocument> {
    await this.requireRun(runId);
    const scheduler = this.createScheduler(runId, request.secretValues);
    await scheduler.startRun({
      workflow: this.definition.ref,
      runId,
    });
    await scheduler.processNext();
    return this.publishSnapshot(await scheduler.snapshot(runId));
  }

  private async requireRun(runId: string): Promise<WorkflowRunDocument> {
    const document = await this.stateStore.getRunDocument(runId);
    if (!document) throw new Error(`Unknown run: ${runId}`);
    return document;
  }

  private createScheduler(
    runId: string,
    secretValues?: Record<string, string>,
  ): LocalScheduler {
    const executor =
      secretValues && Object.keys(secretValues).length > 0
        ? new RuntimeExecutor(secretResolverFromValues(secretValues))
        : this.executor;
    return new LocalScheduler({
      loader: this.loader,
      stateStore: this.stateStore,
      queue: new ScopedWorkflowQueue(this.queue, runId),
      events: new StoreWorkflowEventSink(this.stateStore),
      executor,
    });
  }

  private matchWebhookInputs(
    state: RunSnapshot["state"],
    payload: unknown,
  ): ReturnType<Registry["allInputs"]> {
    const candidateKind =
      state.trigger === undefined ? "input" : "deferred_input";
    return this.registry.allInputs().filter((input) => {
      if (input.kind !== candidateKind || input.secret) return false;
      if (Object.hasOwn(state.inputs, input.id)) return false;
      if (state.nodes[input.id]?.status === "resolved") return false;
      return input.schema.safeParse(payload).success;
    });
  }

  private async publishSnapshot(
    snapshot: RunSnapshot,
  ): Promise<WorkflowRunDocument> {
    const events = await this.stateStore.listEvents(snapshot.runId);
    const document: WorkflowRunDocument = {
      ...snapshot,
      events,
      publishedAt: Date.now(),
    };
    await this.stateStore.saveRunDocument(document);
    return structuredClone(document);
  }
}

function webhookRequestValue(
  request: SubmitWorkflowWebhookRequest,
  requestContext: WorkflowWebhookRequestContext | undefined,
  receivedAt: number,
): Record<string, unknown> {
  return {
    receivedAt,
    method: requestContext?.method ?? "POST",
    route: requestContext?.route ?? "/webhooks",
    url: requestContext?.url,
    headers: requestContext?.headers ?? {},
    query: requestContext?.query ?? {},
    runId: request.runId,
    payload: request.payload,
  };
}

function secretResolverFromValues(
  values: Record<string, string>,
): SecretResolver {
  return {
    resolve: async ({ logicalName }) => values[logicalName],
  };
}

class ScopedWorkflowQueue implements InspectableWorkQueue {
  constructor(
    private readonly queue: WorkflowQueue,
    private readonly runId: string,
  ) {}

  enqueue(event: Parameters<WorkflowQueue["enqueue"]>[0]): Promise<void> {
    return this.queue.enqueue(event);
  }

  enqueueMany(
    events: Parameters<WorkflowQueue["enqueueMany"]>[0],
  ): Promise<void> {
    return this.queue.enqueueMany(events);
  }

  dequeue(): Promise<QueueItem | undefined> {
    return this.queue.claimNext(this.runId);
  }

  complete(eventId: string): Promise<void> {
    return this.queue.complete(eventId);
  }

  fail(eventId: string, error: Error): Promise<void> {
    return this.queue.fail(eventId, error);
  }

  snapshot(): Promise<QueueSnapshot> {
    return this.queue.snapshot(this.runId);
  }

  size(): Promise<number> {
    return this.queue.size(this.runId);
  }
}

class StoreWorkflowEventSink implements WorkflowEventSink {
  constructor(private readonly stateStore: WorkflowStateStore) {}

  publish(event: RunEvent): Promise<void> {
    return this.stateStore.publishEvent(event);
  }

  publishMany(events: RunEvent[]): Promise<void> {
    return this.stateStore.publishEvents(events);
  }
}

function cloneRegistry(registry: Registry): Registry {
  const clone = new Registry();
  for (const input of registry.allInputs()) clone.registerInput(input);
  for (const atom of registry.allAtoms()) clone.registerAtom(atom);
  for (const action of registry.allActions()) clone.registerAction(action);
  return clone;
}

function hashRegistry(registry: Registry): string {
  const source = JSON.stringify({
    inputs: registry.allInputs().map((input) => ({
      id: input.id,
      kind: input.kind,
      secret: input.secret === true,
      description: input.description,
    })),
    atoms: registry.allAtoms().map((atom) => ({
      id: atom.id,
      description: atom.description,
      fn: atom.fn.toString(),
    })),
    actions: registry.allActions().map((action) => ({
      id: action.id,
      description: action.description,
      fn: action.fn.toString(),
    })),
  });
  return hashString(source);
}

function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function randomId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)
  );
}

export function summarizeRun(
  document: WorkflowRunDocument,
): WorkflowRunSummary {
  const waitingOn = new Set<string>();
  let terminalNodeCount = 0;
  let failedNodeCount = 0;

  for (const node of document.nodes) {
    if (isTerminalSummaryNode(document, node)) terminalNodeCount += 1;
    if (node.status === "errored") failedNodeCount += 1;
    if (
      node.status === "waiting" &&
      node.waitingOn &&
      document.state.nodes[node.waitingOn]?.status !== "resolved" &&
      document.state.interventions?.[node.waitingOn]?.status !== "resolved"
    ) {
      waitingOn.add(node.waitingOn);
    }
  }

  return {
    runId: document.runId,
    status: document.status,
    startedAt: document.state.startedAt,
    publishedAt: document.publishedAt,
    triggerInputId: runTriggerInputId(document),
    workflowId: document.workflow.workflowId,
    version: document.version,
    nodeCount: document.nodes.length,
    terminalNodeCount,
    waitingOn: [...waitingOn],
    failedNodeCount,
  };
}

function runTriggerInputId(document: WorkflowRunDocument): string | undefined {
  if (document.state.trigger) return document.state.trigger;
  const queuedInputs = [
    ...document.queue.pending,
    ...document.queue.running,
    ...document.queue.completed,
    ...document.queue.failed,
  ]
    .filter((item) => item.event.kind === "input")
    .sort((a, b) => a.enqueuedAt - b.enqueuedAt);
  const first = queuedInputs[0]?.event;
  return first?.kind === "input" ? first.inputId : undefined;
}

function isTerminalSummaryNode(
  document: WorkflowRunDocument,
  node: WorkflowRunDocument["nodes"][number],
): boolean {
  if (
    node.status === "resolved" ||
    node.status === "skipped" ||
    node.status === "errored"
  ) {
    return true;
  }
  return document.status === "completed" && node.kind === "deferred_input";
}
