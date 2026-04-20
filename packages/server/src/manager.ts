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
  SetWorkflowAutoAdvanceRequest,
  StartWorkflowRunRequest,
  SubmitWorkflowInputRequest,
  SubmitWorkflowInterventionRequest,
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

export class WorkflowManager {
  readonly definition: WorkflowServerDefinition;
  private readonly stateStore: WorkflowStateStore;
  private readonly queue: WorkflowQueue;
  private readonly executor: Executor;

  constructor(options: WorkflowManagerOptions) {
    this.stateStore = options.stateStore;
    this.queue = options.queue;
    this.executor = options.executor ?? new RuntimeExecutor();

    const registry = cloneRegistry(options.registry ?? globalRegistry);
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
    const autoAdvance = request.autoAdvance ?? true;
    const scheduler = this.createScheduler(runId, request.secretValues);
    let snapshot = await scheduler.startRun({
      workflow: this.definition.ref,
      runId,
      input: {
        inputId: request.inputId,
        payload: request.payload,
      },
      additionalInputs: request.additionalInputs,
    });

    if (autoAdvance) {
      await scheduler.drain();
      snapshot = await scheduler.snapshot(runId);
    }

    return this.publishSnapshot(snapshot, autoAdvance);
  }

  async submitInput(
    runId: string,
    request: SubmitWorkflowInputRequest,
  ): Promise<WorkflowRunDocument> {
    const current = await this.requireRun(runId);
    const autoAdvance = request.autoAdvance ?? current.autoAdvance;
    const scheduler = this.createScheduler(runId, request.secretValues);
    let snapshot = await scheduler.submitInput({
      runId,
      workflow: this.definition.ref,
      inputId: request.inputId,
      payload: request.payload,
    });

    if (autoAdvance) {
      await scheduler.drain();
      snapshot = await scheduler.snapshot(runId);
    }

    return this.publishSnapshot(snapshot, autoAdvance);
  }

  async submitIntervention(
    runId: string,
    interventionId: string,
    request: SubmitWorkflowInterventionRequest,
  ): Promise<WorkflowRunDocument> {
    const current = await this.requireRun(runId);
    const autoAdvance = request.autoAdvance ?? current.autoAdvance;
    const scheduler = this.createScheduler(runId, request.secretValues);
    let snapshot = await scheduler.submitIntervention({
      runId,
      workflow: this.definition.ref,
      interventionId,
      payload: request.payload,
    });

    if (autoAdvance) {
      await scheduler.drain();
      snapshot = await scheduler.snapshot(runId);
    }

    return this.publishSnapshot(snapshot, autoAdvance);
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
    return this.publishSnapshot(await scheduler.snapshot(runId), false);
  }

  async setAutoAdvance(
    runId: string,
    request: SetWorkflowAutoAdvanceRequest,
  ): Promise<WorkflowRunDocument> {
    await this.requireRun(runId);
    const scheduler = this.createScheduler(runId, request.secretValues);
    await scheduler.startRun({
      workflow: this.definition.ref,
      runId,
    });

    if (request.autoAdvance) {
      await scheduler.drain();
    }

    return this.publishSnapshot(
      await scheduler.snapshot(runId),
      request.autoAdvance,
    );
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

  private async publishSnapshot(
    snapshot: RunSnapshot,
    autoAdvance: boolean,
  ): Promise<WorkflowRunDocument> {
    const events = await this.stateStore.listEvents(snapshot.runId);
    const document: WorkflowRunDocument = {
      ...snapshot,
      events,
      publishedAt: Date.now(),
      autoAdvance,
    };
    await this.stateStore.saveRunDocument(document);
    return structuredClone(document);
  }
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
    if (node.status === "waiting" && node.waitingOn)
      waitingOn.add(node.waitingOn);
  }

  return {
    runId: document.runId,
    status: document.status,
    startedAt: document.state.startedAt,
    publishedAt: document.publishedAt,
    workflowId: document.workflow.workflowId,
    version: document.version,
    nodeCount: document.nodes.length,
    terminalNodeCount,
    waitingOn: [...waitingOn],
    failedNodeCount,
  };
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
