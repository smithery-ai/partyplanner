import type {
  NodeRecord,
  NodeStatus,
  QueueEvent,
  Registry,
  RunState,
} from "@rxwf/core";
import type {
  EventSink,
  Executor,
  GraphEdge,
  GraphNode,
  InspectableWorkQueue,
  RunEvent,
  RunSnapshot,
  Scheduler,
  StartRunRequest,
  StateStore,
  SubmitInputRequest,
  WorkflowDefinition,
  WorkflowLoader,
  WorkflowRef,
} from "./types";

export type LocalSchedulerOptions = {
  loader: WorkflowLoader;
  stateStore: StateStore;
  queue: InspectableWorkQueue;
  events: EventSink;
  executor: Executor;
};

export class LocalScheduler implements Scheduler {
  private readonly runWorkflows = new Map<string, WorkflowRef>();

  constructor(private readonly opts: LocalSchedulerOptions) {}

  async startRun(request: StartRunRequest): Promise<RunSnapshot> {
    const definition = await this.opts.loader.load(request.workflow);
    const runId = request.runId ?? `run_${randomId()}`;
    const existing = await this.opts.stateStore.load(runId);
    if (existing) {
      this.runWorkflows.set(runId, request.workflow);
      return this.snapshot(runId);
    }

    this.runWorkflows.set(runId, request.workflow);
    const state = makeEmptyRunState(runId);
    const saved = await this.opts.stateStore.save(runId, state, 0);
    if (!saved.ok) throw new Error(`Unable to create run: ${saved.reason}`);

    await this.opts.events.publish({ type: "run_started", runId, at: Date.now() });

    if (request.input) {
      await this.enqueueAndPublish({
        kind: "input",
        eventId: request.input.eventId ?? `evt_${randomId()}`,
        runId,
        inputId: request.input.inputId,
        payload: request.input.payload,
      });
    }

    return this.buildSnapshot(runId, request.workflow, definition, state, saved.version);
  }

  async submitInput(request: SubmitInputRequest): Promise<RunSnapshot> {
    const workflow = request.workflow ?? this.workflowForRun(request.runId);
    await this.opts.loader.load(workflow);
    this.runWorkflows.set(request.runId, workflow);
    await this.enqueueAndPublish({
      kind: "input",
      eventId: request.eventId ?? `evt_${randomId()}`,
      runId: request.runId,
      inputId: request.inputId,
      payload: request.payload,
    });
    return this.snapshot(request.runId);
  }

  async processNext(): Promise<void> {
    const item = await this.opts.queue.dequeue();
    if (!item) return;

    try {
      await this.processEvent(item.event);
      await this.opts.queue.complete(item.event.eventId);
    } catch (e) {
      await this.opts.queue.fail(item.event.eventId, e as Error);
      throw e;
    }
  }

  async drain(): Promise<void> {
    while ((await this.opts.queue.size()) > 0) {
      await this.processNext();
    }
  }

  async processEvent(event: QueueEvent): Promise<void> {
    const workflow = this.workflowForRun(event.runId);
    const definition = await this.opts.loader.load(workflow);
    const stored = await this.opts.stateStore.load(event.runId);
    const previous = stored?.state ?? makeEmptyRunState(event.runId);
    const previousVersion = stored?.version ?? 0;

    if (event.kind === "step") {
      await this.opts.events.publish({
        type: "node_started",
        runId: event.runId,
        nodeId: event.stepId,
        at: Date.now(),
      });
    }

    const result = await this.opts.executor.execute({
      workflow,
      registry: definition.registry,
      event,
      state: previous,
    });

    await this.publishStateDelta(event, previous, result.state);
    await this.enqueueAndPublishMany(result.emitted);

    const saved = await this.opts.stateStore.save(event.runId, result.state, previousVersion);
    if (!saved.ok) throw new Error(`Unable to save run: ${saved.reason}`);

    await this.publishRunStatus(event.runId, result.state);
  }

  async snapshot(runId: string): Promise<RunSnapshot> {
    const workflow = this.workflowForRun(runId);
    const definition = await this.opts.loader.load(workflow);
    const stored = await this.opts.stateStore.load(runId);
    if (!stored) throw new Error(`Unknown run: ${runId}`);
    return this.buildSnapshot(runId, workflow, definition, stored.state, stored.version);
  }

  private async enqueueAndPublish(event: QueueEvent): Promise<void> {
    await this.opts.queue.enqueue(event);
    await this.publishQueued(event);
  }

  private async enqueueAndPublishMany(events: QueueEvent[]): Promise<void> {
    await this.opts.queue.enqueueMany(events);
    await this.opts.events.publishMany(
      events.map((event) => queuedEvent(event)).filter((event): event is RunEvent => Boolean(event)),
    );
  }

  private async publishQueued(event: QueueEvent): Promise<void> {
    const queued = queuedEvent(event);
    if (queued) await this.opts.events.publish(queued);
  }

  private async publishStateDelta(
    event: QueueEvent,
    previous: RunState,
    next: RunState,
  ): Promise<void> {
    const events: RunEvent[] = [];

    if (event.kind === "input") {
      events.push({
        type: "input_received",
        runId: event.runId,
        inputId: event.inputId,
        at: Date.now(),
      });
    }

    for (const [nodeId, record] of Object.entries(next.nodes)) {
      const prev = previous.nodes[nodeId];
      for (const dep of record.deps) {
        if (!prev?.deps.includes(dep)) {
          events.push({
            type: "edge_discovered",
            runId: next.runId,
            source: dep,
            target: nodeId,
            at: Date.now(),
          });
        }
      }

      if (prev?.status === record.status && prev?.attempts === record.attempts) continue;
      const nodeEvent = recordEvent(next.runId, nodeId, record);
      if (nodeEvent) events.push(nodeEvent);
    }

    await this.opts.events.publishMany(events);
  }

  private async publishRunStatus(runId: string, state: RunState): Promise<void> {
    const waitingOn = unresolvedWaitingInputs(state);
    if (waitingOn.length > 0 && (await this.opts.queue.size()) === 0) {
      await this.opts.events.publish({
        type: "run_waiting",
        runId,
        waitingOn,
        at: Date.now(),
      });
      return;
    }

    if (isComplete(state) && (await this.opts.queue.size()) === 0) {
      await this.opts.events.publish({ type: "run_completed", runId, at: Date.now() });
    }
  }

  private async buildSnapshot(
    runId: string,
    workflow: WorkflowRef,
    definition: WorkflowDefinition,
    state: RunState,
    version: number,
  ): Promise<RunSnapshot> {
    const queue = await this.opts.queue.snapshot();
    return {
      runId,
      workflow,
      status: runStatus(state, queue.pending.length + queue.running.length),
      nodes: buildGraphNodes(definition.registry, state, queue),
      edges: buildGraphEdges(state),
      queue,
      state: structuredClone(state),
      version,
    };
  }

  private workflowForRun(runId: string): WorkflowRef {
    const workflow = this.runWorkflows.get(runId);
    if (!workflow) throw new Error(`Unknown workflow for run: ${runId}`);
    return workflow;
  }
}

function makeEmptyRunState(runId: string): RunState {
  return {
    runId,
    startedAt: Date.now(),
    inputs: {},
    nodes: {},
    waiters: {},
    processedEventIds: {},
  };
}

function queuedEvent(event: QueueEvent): RunEvent | undefined {
  if (event.kind === "input") {
    return {
      type: "node_queued",
      runId: event.runId,
      nodeId: event.inputId,
      at: Date.now(),
    };
  }
  return {
    type: "node_queued",
    runId: event.runId,
    nodeId: event.stepId,
    at: Date.now(),
  };
}

function recordEvent(runId: string, nodeId: string, record: NodeRecord): RunEvent | undefined {
  switch (record.status) {
    case "resolved":
      return { type: "node_resolved", runId, nodeId, at: Date.now() };
    case "skipped":
      return { type: "node_skipped", runId, nodeId, reason: record.skipReason, at: Date.now() };
    case "waiting":
      return {
        type: "node_waiting",
        runId,
        nodeId,
        waitingOn: record.waitingOn!,
        at: Date.now(),
      };
    case "blocked":
      return {
        type: "node_blocked",
        runId,
        nodeId,
        blockedOn: record.blockedOn!,
        at: Date.now(),
      };
    case "errored":
      return {
        type: "node_errored",
        runId,
        nodeId,
        message: record.error?.message ?? "Unknown error",
        at: Date.now(),
      };
    case "not_reached":
      return undefined;
  }
}

function buildGraphNodes(
  registry: Registry,
  state: RunState,
  queue: Awaited<ReturnType<InspectableWorkQueue["snapshot"]>>,
): GraphNode[] {
  const pending = new Set(queue.pending.map((item) => queueNodeId(item.event)));
  const running = new Set(queue.running.map((item) => queueNodeId(item.event)));

  return registry.allIds().map((id) => {
    const inputDef = registry.getInput(id);
    const atomDef = registry.getAtom(id);
    const rec = state.nodes[id] ?? fallbackRecord(inputDef?.kind);
    return {
      id,
      kind: inputDef?.kind ?? "atom",
      description: inputDef?.description ?? atomDef?.description,
      status: running.has(id) ? "running" : pending.has(id) ? "queued" : rec.status,
      value: rec.value,
      deps: rec.deps,
      blockedOn: rec.blockedOn,
      waitingOn: rec.waitingOn,
      skipReason: rec.skipReason,
      attempts: rec.attempts,
    };
  });
}

function fallbackRecord(kind: "input" | "deferred_input" | undefined): NodeRecord {
  if (kind === "input") {
    return {
      status: "skipped",
      deps: [],
      duration_ms: 0,
      attempts: 0,
    };
  }
  return {
    status: "not_reached",
    deps: [],
    duration_ms: 0,
    attempts: 0,
  };
}

function buildGraphEdges(state: RunState): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  for (const [target, rec] of Object.entries(state.nodes)) {
    for (const source of new Set(rec.deps)) {
      const id = `${source}->${target}`;
      if (seen.has(id)) continue;
      seen.add(id);
      edges.push({ id, source, target });
    }
  }
  return edges;
}

function queueNodeId(event: QueueEvent): string {
  return event.kind === "input" ? event.inputId : event.stepId;
}

function runStatus(state: RunState, activeQueueItems: number): RunSnapshot["status"] {
  if (Object.values(state.nodes).some((record) => record.status === "errored")) return "failed";
  if (activeQueueItems > 0) return "running";
  if (unresolvedWaitingInputs(state).length > 0) return "waiting";
  if (isComplete(state)) return "completed";
  return "created";
}

function unresolvedWaitingInputs(state: RunState): string[] {
  const waiting = new Set<string>();
  for (const record of Object.values(state.nodes)) {
    if (record.status === "waiting" && record.waitingOn) waiting.add(record.waitingOn);
  }
  return [...waiting];
}

function isComplete(state: RunState): boolean {
  const records = Object.values(state.nodes);
  if (records.length === 0) return false;
  return records.every((record) => isTerminal(record.status));
}

function isTerminal(status: NodeStatus): boolean {
  return status === "resolved" || status === "skipped" || status === "errored";
}

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
}
