import type {
  NodeRecord,
  NodeStatus,
  QueueEvent,
  Registry,
  RunState,
} from "@workflow/core";
import type {
  EventSink,
  Executor,
  GraphEdge,
  GraphNode,
  InspectableWorkQueue,
  ManagedConnectionResolver,
  RunEvent,
  RunSnapshot,
  Scheduler,
  StartRunRequest,
  StateStore,
  SubmitInputRequest,
  SubmitInterventionRequest,
  SubmitManagedConnectionRequest,
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
  managedConnectionResolver?: ManagedConnectionResolver;
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

    await this.opts.events.publish({
      type: "run_started",
      runId,
      at: Date.now(),
    });

    if (request.input) {
      await this.enqueueAndPublish({
        kind: "input",
        eventId: request.input.eventId ?? `evt_${randomId()}`,
        runId,
        inputId: request.input.inputId,
        payload: request.input.payload,
      });
    }
    for (const input of request.additionalInputs ?? []) {
      await this.enqueueAndPublish({
        kind: "input",
        eventId: input.eventId ?? `evt_${randomId()}`,
        runId,
        inputId: input.inputId,
        payload: input.payload,
      });
    }

    return this.buildSnapshot(
      runId,
      request.workflow,
      definition,
      state,
      saved.version,
    );
  }

  async submitInput(request: SubmitInputRequest): Promise<RunSnapshot> {
    const workflow = request.workflow ?? this.workflowForRun(request.runId);
    const definition = await this.opts.loader.load(workflow);
    this.runWorkflows.set(request.runId, workflow);

    const inputDef = definition.registry.getInput(request.inputId);
    if (!inputDef) throw new Error(`Unknown input: ${request.inputId}`);

    if (inputDef.kind !== "deferred_input") {
      await this.enqueueAndPublish({
        kind: "input",
        eventId: request.eventId ?? `evt_${randomId()}`,
        runId: request.runId,
        inputId: request.inputId,
        payload: request.payload,
      });
      return this.snapshot(request.runId);
    }

    const stored = await this.opts.stateStore.load(request.runId);
    if (!stored) {
      throw new Error(`Unknown run: ${request.runId}`);
    }

    const state = structuredClone(stored.state);
    const resolvedValue = inputDef.schema.parse(request.payload);
    const previous = state.nodes[request.inputId];

    state.inputs[request.inputId] = resolvedValue;
    state.nodes[request.inputId] = {
      status: "resolved",
      kind: inputDef.kind,
      value: resolvedValue,
      deps: [],
      duration_ms: 0,
      attempts: (previous?.attempts ?? 0) + 1,
    };

    const waiters = waitersForDependency(state, request.inputId);
    delete state.waiters[request.inputId];

    const saved = await this.opts.stateStore.save(
      request.runId,
      state,
      stored.version,
    );
    if (!saved.ok) throw new Error(`Unable to save run: ${saved.reason}`);

    const events: RunEvent[] = [
      {
        type: "input_received",
        runId: request.runId,
        inputId: request.inputId,
        at: Date.now(),
      },
    ];
    const nodeEvent = recordEvent(
      request.runId,
      request.inputId,
      state.nodes[request.inputId],
    );
    if (nodeEvent) events.push(nodeEvent);
    await this.opts.events.publishMany(events);
    await this.enqueueAndPublishMany(
      waiters.flatMap((stepId) => emitStepEvent(state, stepId)),
    );
    await this.publishRunStatus(request.runId, state);

    return this.buildSnapshot(
      request.runId,
      workflow,
      definition,
      state,
      saved.version,
    );
  }

  async submitManagedConnection(
    request: SubmitManagedConnectionRequest,
  ): Promise<RunSnapshot> {
    const workflow = request.workflow ?? this.workflowForRun(request.runId);
    const definition = await this.opts.loader.load(workflow);
    this.runWorkflows.set(request.runId, workflow);

    const stepDef = definition.registry.getAtom(request.connectionId);
    if (!stepDef?.managedConnection) {
      throw new Error(`Unknown managed connection: ${request.connectionId}`);
    }

    const stored = await this.opts.stateStore.load(request.runId);
    if (!stored) throw new Error(`Unknown run: ${request.runId}`);

    await this.processEvent({
      kind: "step",
      eventId: `evt_${randomId()}`,
      runId: request.runId,
      stepId: request.connectionId,
      reason: "managed_connection",
    });

    return this.snapshot(request.runId);
  }

  async submitIntervention(
    request: SubmitInterventionRequest,
  ): Promise<RunSnapshot> {
    const workflow = request.workflow ?? this.workflowForRun(request.runId);
    const definition = await this.opts.loader.load(workflow);
    this.runWorkflows.set(request.runId, workflow);

    const stored = await this.opts.stateStore.load(request.runId);
    if (!stored) throw new Error(`Unknown run: ${request.runId}`);

    const state = structuredClone(stored.state);
    state.interventions ??= {};

    const intervention = state.interventions[request.interventionId];
    if (!intervention) {
      throw new Error(`Unknown intervention: ${request.interventionId}`);
    }

    state.inputs[request.interventionId] = request.payload;
    state.interventions[request.interventionId] = {
      ...intervention,
      status: "resolved",
      resolvedAt: Date.now(),
    };

    const waiters = waitersForDependency(state, request.interventionId);
    delete state.waiters[request.interventionId];

    const saved = await this.opts.stateStore.save(
      request.runId,
      state,
      stored.version,
    );
    if (!saved.ok) throw new Error(`Unable to save run: ${saved.reason}`);

    await this.opts.events.publish({
      type: "intervention_received",
      runId: request.runId,
      interventionId: request.interventionId,
      at: Date.now(),
    });
    await this.enqueueAndPublishMany(
      waiters.flatMap((stepId) => emitStepEvent(state, stepId)),
    );

    return this.buildSnapshot(
      request.runId,
      workflow,
      definition,
      state,
      saved.version,
    );
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
    const stepDef =
      event.kind === "step"
        ? definition.registry.getAtom(event.stepId)
        : undefined;
    let previous = stored?.state ?? makeEmptyRunState(event.runId);
    let previousVersion = stored?.version ?? 0;

    if (event.kind === "step") {
      await this.opts.events.publish({
        type: "node_started",
        runId: event.runId,
        nodeId: event.stepId,
        at: Date.now(),
      });
    }

    if (
      event.kind === "step" &&
      previous.trigger === undefined &&
      event.reason !== "managed_connection" &&
      !stepDef?.managedConnection
    ) {
      const recovered = await this.recoverMissingTrigger({
        workflow,
        definition,
        state: previous,
        version: previousVersion,
      });
      previous = recovered.state;
      previousVersion = recovered.version;
    }

    const managedConnectionHandled = await this.resolveManagedConnection({
      event,
      workflow,
      definition,
      state: previous,
      version: previousVersion,
    });
    if (managedConnectionHandled) {
      return;
    }

    const result = await this.opts.executor.execute({
      workflow,
      registry: definition.registry,
      event,
      state: previous,
    });

    const saved = await this.opts.stateStore.save(
      event.runId,
      result.state,
      previousVersion,
    );
    if (!saved.ok) throw new Error(`Unable to save run: ${saved.reason}`);

    await this.publishStateDelta(event, previous, result.state);
    await this.enqueueAndPublishMany(result.emitted);
    await this.publishRunStatus(event.runId, result.state);
  }

  private async resolveManagedConnection(request: {
    event: QueueEvent;
    workflow: WorkflowRef;
    definition: WorkflowDefinition;
    state: RunState;
    version: number;
  }): Promise<boolean> {
    if (
      request.event.kind !== "step" ||
      request.event.reason === "managed_connection" ||
      !this.opts.managedConnectionResolver
    ) {
      return false;
    }

    const stepDef = request.definition.registry.getAtom(request.event.stepId);
    if (!stepDef?.managedConnection) return false;

    const resolvedValue = await this.opts.managedConnectionResolver.resolve({
      workflow: request.workflow,
      runId: request.event.runId,
      connectionId: request.event.stepId,
    });
    const previous = request.state.nodes[request.event.stepId];
    const next = structuredClone(request.state);

    if (resolvedValue === undefined) {
      next.nodes[request.event.stepId] = {
        status: "blocked",
        kind: stepDef.kind,
        deps: [],
        duration_ms: 0,
        attempts: (previous?.attempts ?? 0) + 1,
        blockedOn: `@configuration/${request.event.stepId}`,
      };
    } else {
      next.nodes[request.event.stepId] = {
        status: "resolved",
        kind: stepDef.kind,
        value: resolvedValue,
        deps: [],
        duration_ms: 0,
        attempts: (previous?.attempts ?? 0) + 1,
      };
      const waiters = waitersForDependency(next, request.event.stepId);
      delete next.waiters[request.event.stepId];
      await this.saveResolvedManagedConnection(
        request.event,
        request.state,
        next,
        request.version,
        waiters,
      );
      return true;
    }

    const saved = await this.opts.stateStore.save(
      request.event.runId,
      next,
      request.version,
    );
    if (!saved.ok) throw new Error(`Unable to save run: ${saved.reason}`);

    await this.publishStateDelta(request.event, request.state, next);
    await this.publishRunStatus(request.event.runId, next);
    return true;
  }

  private async saveResolvedManagedConnection(
    event: Extract<QueueEvent, { kind: "step" }>,
    previous: RunState,
    next: RunState,
    version: number,
    waiters: string[],
  ): Promise<void> {
    const saved = await this.opts.stateStore.save(event.runId, next, version);
    if (!saved.ok) throw new Error(`Unable to save run: ${saved.reason}`);

    await this.publishStateDelta(event, previous, next);
    await this.enqueueAndPublishMany(
      waiters.flatMap((stepId) => emitStepEvent(next, stepId)),
    );
    await this.publishRunStatus(event.runId, next);
  }

  private async recoverMissingTrigger(request: {
    workflow: WorkflowRef;
    definition: WorkflowDefinition;
    state: RunState;
    version: number;
  }): Promise<{ state: RunState; version: number }> {
    const triggerEvent = await this.triggerInputFromQueue();
    if (!triggerEvent) {
      throw new Error("Cannot process step before trigger input is available");
    }

    const result = await this.opts.executor.execute({
      workflow: request.workflow,
      registry: request.definition.registry,
      event: triggerEvent,
      state: request.state,
    });

    const saved = await this.opts.stateStore.save(
      triggerEvent.runId,
      result.state,
      request.version,
    );
    if (!saved.ok) throw new Error(`Unable to recover run: ${saved.reason}`);

    await this.publishStateDelta(triggerEvent, request.state, result.state);
    await this.enqueueAndPublishMany(result.emitted);
    return { state: result.state, version: saved.version };
  }

  private async triggerInputFromQueue(): Promise<
    Extract<QueueEvent, { kind: "input" }> | undefined
  > {
    const queue = await this.opts.queue.snapshot();
    const items = [
      ...queue.pending,
      ...queue.running,
      ...queue.completed,
      ...queue.failed,
    ]
      .filter((item) => item.event.kind === "input")
      .sort((a, b) => a.enqueuedAt - b.enqueuedAt);
    const event = items[0]?.event;
    return event?.kind === "input" ? event : undefined;
  }

  async snapshot(runId: string): Promise<RunSnapshot> {
    const workflow = this.workflowForRun(runId);
    const definition = await this.opts.loader.load(workflow);
    const stored = await this.opts.stateStore.load(runId);
    if (!stored) throw new Error(`Unknown run: ${runId}`);
    return this.buildSnapshot(
      runId,
      workflow,
      definition,
      stored.state,
      stored.version,
    );
  }

  private async enqueueAndPublish(event: QueueEvent): Promise<void> {
    await this.opts.queue.enqueue(event);
    await this.publishQueued(event);
  }

  private async enqueueAndPublishMany(events: QueueEvent[]): Promise<void> {
    await this.opts.queue.enqueueMany(events);
    await this.opts.events.publishMany(
      events
        .map((event) => queuedEvent(event))
        .filter((event): event is RunEvent => Boolean(event)),
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

      if (prev?.status === record.status && prev?.attempts === record.attempts)
        continue;
      const nodeEvent = recordEvent(next.runId, nodeId, record);
      if (nodeEvent) events.push(nodeEvent);
    }

    await this.opts.events.publishMany(events);
  }

  private async publishRunStatus(
    runId: string,
    state: RunState,
  ): Promise<void> {
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
      await this.opts.events.publish({
        type: "run_completed",
        runId,
        at: Date.now(),
      });
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
    interventions: {},
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

function recordEvent(
  runId: string,
  nodeId: string,
  record: NodeRecord,
): RunEvent | undefined {
  switch (record.status) {
    case "resolved":
      return { type: "node_resolved", runId, nodeId, at: Date.now() };
    case "skipped":
      return {
        type: "node_skipped",
        runId,
        nodeId,
        reason: record.skipReason,
        at: Date.now(),
      };
    case "waiting":
      if (record.waitingOn === undefined) {
        throw new Error(`Waiting node "${nodeId}" is missing waitingOn`);
      }
      return {
        type: "node_waiting",
        runId,
        nodeId,
        waitingOn: record.waitingOn,
        at: Date.now(),
      };
    case "blocked":
      if (record.blockedOn === undefined) {
        throw new Error(`Blocked node "${nodeId}" is missing blockedOn`);
      }
      return {
        type: "node_blocked",
        runId,
        nodeId,
        blockedOn: record.blockedOn,
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

  const ids = new Set([...registry.allIds(), ...Object.keys(state.nodes)]);
  return [...ids].map((id) => {
    const inputDef = registry.getInput(id);
    const atomDef = registry.getAtom(id);
    const actionDef = registry.getAction(id);
    const rec = state.nodes[id] ?? fallbackRecord(inputDef?.kind);
    return {
      id,
      kind:
        inputDef?.kind ??
        atomDef?.kind ??
        actionDef?.kind ??
        rec.kind ??
        "atom",
      secret: inputDef?.secret,
      description:
        inputDef?.description ??
        atomDef?.description ??
        actionDef?.description ??
        (rec.kind === "webhook"
          ? "Most recent webhook request received for this run."
          : undefined),
      status: running.has(id)
        ? "running"
        : pending.has(id)
          ? "queued"
          : rec.status,
      value:
        inputDef?.secret && rec.value !== undefined ? "[secret]" : rec.value,
      deps: rec.deps,
      blockedOn: rec.blockedOn,
      waitingOn: rec.waitingOn,
      skipReason: rec.skipReason,
      attempts: rec.attempts,
    };
  });
}

function fallbackRecord(
  kind: "input" | "deferred_input" | undefined,
): NodeRecord {
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
  const webhookNodeId = state.webhook?.nodeId;
  if (webhookNodeId) {
    for (const target of state.webhook?.matchedInputs ?? []) {
      const id = `${webhookNodeId}->${target}`;
      if (seen.has(id)) continue;
      seen.add(id);
      edges.push({ id, source: webhookNodeId, target });
    }
  }
  return edges;
}

function queueNodeId(event: QueueEvent): string {
  return event.kind === "input" ? event.inputId : event.stepId;
}

function runStatus(
  state: RunState,
  activeQueueItems: number,
): RunSnapshot["status"] {
  if (state.terminal) return state.terminal.status;
  if (Object.values(state.nodes).some((record) => record.status === "errored"))
    return "failed";
  if (activeQueueItems > 0) return "running";
  if (unresolvedWaitingInputs(state).length > 0) return "waiting";
  if (isComplete(state)) return "completed";
  return "created";
}

function unresolvedWaitingInputs(state: RunState): string[] {
  const waiting = new Set<string>();
  for (const record of Object.values(state.nodes)) {
    if (record.status === "waiting" && record.waitingOn)
      waiting.add(record.waitingOn);
  }
  return [...waiting];
}

function waitersForDependency(state: RunState, depId: string): string[] {
  const waiters = new Set(state.waiters[depId] ?? []);
  for (const [stepId, record] of Object.entries(state.nodes)) {
    if (record.status === "waiting" && record.waitingOn === depId) {
      waiters.add(stepId);
    }
  }
  return [...waiters];
}

function emitStepEvent(state: RunState, stepId: string): QueueEvent[] {
  const rec = state.nodes[stepId];
  if (
    rec?.status === "resolved" ||
    rec?.status === "skipped" ||
    rec?.status === "errored"
  ) {
    return [];
  }
  return [
    {
      kind: "step",
      eventId: `evt_${randomId()}`,
      runId: state.runId,
      stepId,
      reason: "dependency",
    },
  ];
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
  return (
    globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)
  );
}
