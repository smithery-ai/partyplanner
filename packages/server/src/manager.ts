import { globalRegistry, Registry } from "@workflow/core";
import {
  type Executor,
  type InspectableWorkQueue,
  LocalScheduler,
  type ManagedConnectionResolver,
  type QueueItem,
  type QueueSnapshot,
  type RunEvent,
  type RunSnapshot,
  RuntimeExecutor,
  type SecretResolver,
  StaticWorkflowLoader,
  type WorkflowRef,
} from "@workflow/runtime";
import { cronMatches, type ParsedCron, parseCron } from "./cron";
import { buildWorkflowManifest, type WorkflowManifest } from "./manifest";
import type {
  ConnectManagedConnectionRequest,
  StartWorkflowRunRequest,
  SubmitWorkflowInputRequest,
  SubmitWorkflowInterventionRequest,
  SubmitWorkflowWebhookRequest,
  WorkflowConfigurationDocument,
  WorkflowEventSink,
  WorkflowManagedConnectionConfiguration,
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
const CONFIG_RUN_PREFIX = "@configuration/";
const CONFIG_TRIGGER_ID = "@configuration";

export type TickScheduleFiring = {
  id: string;
  cron: string;
  runId: string;
};

export type TickScheduleSkip = {
  id: string;
  cron: string;
  reason: "parse_error" | "submit_error";
  message: string;
};

export type TickSchedulesResult = {
  at: string;
  fired: TickScheduleFiring[];
  skipped: TickScheduleSkip[];
};

export type PumpedRun =
  | { runId: string; outcome: "advanced"; status: string }
  | { runId: string; outcome: "skipped_budget" }
  | { runId: string; outcome: "errored"; error: string };

export type PumpInProgressRunsResult = {
  attempted: number;
  pumped: PumpedRun[];
};

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

  async listRuns(): Promise<WorkflowRunSummary[]> {
    return (
      await this.stateStore.listRunSummaries(this.definition.ref.workflowId)
    ).filter((run) => run.runId !== this.configurationRunId());
  }

  getRun(runId: string): Promise<WorkflowRunDocument | undefined> {
    return this.stateStore.getRunDocument(runId);
  }

  async configuration(): Promise<WorkflowConfigurationDocument> {
    return this.loadConfiguration();
  }

  async startRun(
    request: StartWorkflowRunRequest,
  ): Promise<WorkflowRunDocument> {
    await this.requireConfigurationReady();
    const runId = request.runId ?? `run_${randomId()}`;
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
    await this.seedConfiguredManagedConnections(runId, snapshot.version);
    snapshot = await scheduler.snapshot(runId);
    return this.publishSnapshot(snapshot);
  }

  async connectManagedConnection(
    connectionId: string,
    request: ConnectManagedConnectionRequest = {},
  ): Promise<WorkflowConfigurationDocument> {
    const configRunId = this.configurationRunId();
    const scheduler = this.createScheduler(configRunId, request.secretValues, {
      mode: "configuration",
    });
    await this.ensureConfigurationRun(scheduler, configRunId);
    if (request.restart) {
      await this.resetManagedConnection(configRunId, connectionId);
    }
    await this.publishSnapshot(
      await scheduler.submitManagedConnection({
        runId: configRunId,
        workflow: this.definition.ref,
        connectionId,
      }),
    );
    await this.advanceConfigurationUntilSettled(
      connectionId,
      request.secretValues,
    );
    return this.loadConfiguration();
  }

  async clearManagedConnection(
    connectionId: string,
  ): Promise<WorkflowConfigurationDocument> {
    const configRunId = this.configurationRunId();
    const scheduler = this.createScheduler(configRunId, undefined, {
      mode: "configuration",
    });
    await this.ensureConfigurationRun(scheduler, configRunId);
    await this.resetManagedConnection(configRunId, connectionId);
    await this.publishSnapshot(await scheduler.snapshot(configRunId));
    return this.loadConfiguration();
  }

  private async resetManagedConnection(
    runId: string,
    connectionId: string,
  ): Promise<void> {
    const interventionId = `${connectionId}:oauth-callback`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const stored = await this.stateStore.load(runId);
      if (!stored) return;

      const state = structuredClone(stored.state);
      delete state.inputs[interventionId];
      delete state.interventions?.[interventionId];
      delete state.waiters[interventionId];
      delete state.nodes[connectionId];

      const saved = await this.stateStore.save(runId, state, stored.version);
      if (saved.ok) return;
      if (saved.reason !== "conflict") {
        throw new Error(
          `Unable to restart managed connection "${connectionId}": ${saved.reason}`,
        );
      }
    }

    throw new Error(
      `Unable to restart managed connection "${connectionId}": conflict`,
    );
  }

  async submitInput(
    runId: string,
    request: SubmitWorkflowInputRequest,
  ): Promise<WorkflowRunDocument> {
    if (runId !== this.configurationRunId()) {
      await this.requireConfigurationReady();
    }
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
    await this.requireConfigurationReady();
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
    let baseSnapshot = await scheduler.startRun({
      workflow: this.definition.ref,
      runId,
    });
    await this.seedConfiguredManagedConnections(runId, baseSnapshot.version);
    baseSnapshot = await scheduler.snapshot(runId);
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

  async tickSchedules(at: Date = new Date()): Promise<TickSchedulesResult> {
    const fired: TickScheduleFiring[] = [];
    const skipped: TickScheduleSkip[] = [];
    for (const schedule of this.registry.allSchedules()) {
      let parsed: ParsedCron;
      try {
        parsed = parseCron(schedule.cron);
      } catch (error) {
        skipped.push({
          id: schedule.id,
          cron: schedule.cron,
          reason: "parse_error",
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (!cronMatches(parsed, at)) continue;
      try {
        const run = await this.startRun({
          inputId: schedule.inputId,
          payload: schedule.payload,
        });
        fired.push({ id: schedule.id, cron: schedule.cron, runId: run.runId });
      } catch (error) {
        skipped.push({
          id: schedule.id,
          cron: schedule.cron,
          reason: "submit_error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { at: at.toISOString(), fired, skipped };
  }

  // Fire a single registered schedule by id, using its captured payload. Used
  // by the UI's "Run now" button so the client never has to know the payload
  // (which only exists in workflow code).
  async runScheduleNow(scheduleId: string): Promise<WorkflowRunDocument> {
    const schedule = this.registry.getSchedule(scheduleId);
    if (!schedule) {
      throw new Error(`Unknown schedule: ${scheduleId}`);
    }
    return this.startRun({
      inputId: schedule.inputId,
      payload: schedule.payload,
    });
  }

  async submitIntervention(
    runId: string,
    interventionId: string,
    request: SubmitWorkflowInterventionRequest,
  ): Promise<WorkflowRunDocument> {
    const mode = runId === this.configurationRunId() ? "configuration" : "run";
    const scheduler = this.createScheduler(runId, request.secretValues, {
      mode,
    });
    const snapshot = await scheduler.submitIntervention({
      runId,
      workflow: this.definition.ref,
      interventionId,
      payload: request.payload,
    });
    if (mode === "configuration") {
      await this.advanceConfigurationUntilSettled(
        interventionId.split(":")[0] ?? "",
        request.secretValues,
      );
      return this.requireRun(runId);
    }
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

  private configurationRunId(): string {
    return `${CONFIG_RUN_PREFIX}${this.definition.ref.workflowId}`;
  }

  private async loadConfiguration(): Promise<WorkflowConfigurationDocument> {
    const runId = this.configurationRunId();
    const run = await this.stateStore.getRunDocument(runId);
    const connections = this.buildConfigurationConnections(run);
    return {
      runId,
      ready: connections.every(
        (connection) => connection.status === "connected",
      ),
      connections,
      ...(run ? { run } : {}),
    };
  }

  private buildConfigurationConnections(
    run: WorkflowRunDocument | undefined,
  ): WorkflowManagedConnectionConfiguration[] {
    const queued = new Set(
      [...(run?.queue.pending ?? []), ...(run?.queue.running ?? [])].map(
        (item) =>
          item.event.kind === "input" ? item.event.inputId : item.event.stepId,
      ),
    );
    return this.definition.manifest.managedConnections.map((connection) => {
      const node = run?.state.nodes[connection.id];
      const intervention =
        run?.state.interventions?.[`${connection.id}:oauth-callback`];
      let status: WorkflowManagedConnectionConfiguration["status"] =
        "not_connected";
      if (node?.status === "resolved") {
        status = "connected";
      } else if (node?.status === "errored") {
        status = "error";
      } else if (
        queued.has(connection.id) ||
        node?.status === "waiting" ||
        node?.status === "blocked" ||
        intervention?.status === "pending"
      ) {
        status = "connecting";
      }
      return {
        ...connection,
        status,
        waitingOn: node?.waitingOn,
      };
    });
  }

  private async requireConfigurationReady(): Promise<void> {
    const configuration = await this.loadConfiguration();
    const missing = configuration.connections.filter(
      (connection) => connection.status !== "connected",
    );
    if (missing.length === 0) return;
    throw new Error(
      `Worker configuration incomplete. Connect ${missing
        .map((connection) => connection.title ?? connection.providerId)
        .join(", ")} before starting a run.`,
    );
  }

  private createScheduler(
    runId: string,
    secretValues?: Record<string, string>,
    options: { mode?: "configuration" | "run" } = {},
  ): LocalScheduler {
    const executor =
      secretValues && Object.keys(secretValues).length > 0
        ? new RuntimeExecutor(secretResolverFromValues(secretValues))
        : this.executor;
    const managedConnectionResolver =
      options.mode === "configuration"
        ? undefined
        : this.managedConnectionResolver();
    return new LocalScheduler({
      loader: this.loader,
      stateStore: this.stateStore,
      queue: new ScopedWorkflowQueue(this.queue, runId),
      events: new StoreWorkflowEventSink(this.stateStore),
      executor,
      managedConnectionResolver,
    });
  }

  private managedConnectionResolver(): ManagedConnectionResolver {
    return {
      resolve: async ({ connectionId }) => {
        const configurationRun = await this.stateStore.load(
          this.configurationRunId(),
        );
        const node = configurationRun?.state.nodes[connectionId];
        return node?.status === "resolved" ? node.value : undefined;
      },
    };
  }

  // Drive a run forward by repeatedly calling processNext() until the run
  // either settles into a terminal status, transitions to `waiting` (deferred
  // input or paused), or has an empty queue. The manager's mutating entry
  // points (startRun, submitInput, submitWebhook, submitIntervention) intentionally
  // process a single event and return — keeping a tight, observable contract.
  // Callers that want "drive until parked" semantics — typically HTTP route
  // handlers in reactive backends (Cloudflare and Node tenant workers, neither
  // of which has a background pump for individual run queues) — call this
  // explicitly. Step-at-a-time tooling and observability paths can avoid it.
  async advanceUntilSettled(
    runId: string,
    request: {
      secretValues?: Record<string, string>;
      maxAttempts?: number;
    } = {},
  ): Promise<WorkflowRunDocument> {
    const maxAttempts = request.maxAttempts ?? 32;
    const scheduler = this.createScheduler(runId, request.secretValues);
    let document = await this.requireRun(runId);
    // Bind this scheduler instance to the existing run; processNext() requires
    // it to know which workflow it's pumping. (createScheduler only allocates
    // the scheduler — it doesn't load run state on its own.)
    await scheduler.startRun({ workflow: this.definition.ref, runId });
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (document.status !== "running") return document;
      if (document.queue.pending.length + document.queue.running.length === 0) {
        return document;
      }
      try {
        await scheduler.processNext();
      } catch (e) {
        if (isRunSaveConflictError(e)) continue;
        throw e;
      }
      document = await this.publishSnapshot(await scheduler.snapshot(runId));
    }
    return document;
  }

  // Heartbeat for in-flight runs. Every cron tick, after firing schedules
  // whose cron matches, we also walk every run still in `running` and pump
  // it forward. Without this, a run that hit the worker's wall-clock kill
  // mid-drain (and got recovered by claimNext's lease retry) would only
  // resume when something explicitly poked it — `tickSchedules` itself
  // doesn't iterate live runs, only fresh firings. The pump closes that
  // loop so the cron actually delivers what schedule() advertises:
  // scheduled work that progresses.
  //
  // Each call is bounded so it can't itself blow past the worker's
  // wall-clock budget:
  //   - `maxAttemptsPerRun` caps processNext invocations per run (default
  //     4 — enough to make meaningful progress without monopolizing the
  //     tick).
  //   - `budgetMs` caps total wall time across all runs; once exceeded,
  //     remaining runs are deferred to the next tick.
  // Concurrent ticks pumping the same run are safe — claimNext is atomic
  // (FOR UPDATE SKIP LOCKED), so one wins and the other no-ops.
  async pumpInProgressRuns(
    request: { maxAttemptsPerRun?: number; budgetMs?: number } = {},
  ): Promise<PumpInProgressRunsResult> {
    const maxAttemptsPerRun = request.maxAttemptsPerRun ?? 4;
    const budgetMs = request.budgetMs ?? 15_000;
    const deadline = Date.now() + budgetMs;
    const summaries = await this.stateStore.listRunSummaries(
      this.definition.ref.workflowId,
    );
    const inProgress = summaries.filter(
      (summary) => summary.status === "running",
    );
    const pumped: PumpedRun[] = [];
    for (const summary of inProgress) {
      if (Date.now() >= deadline) {
        pumped.push({ runId: summary.runId, outcome: "skipped_budget" });
        continue;
      }
      try {
        const document = await this.advanceUntilSettled(summary.runId, {
          maxAttempts: maxAttemptsPerRun,
        });
        pumped.push({
          runId: summary.runId,
          outcome: "advanced",
          status: document.status,
        });
      } catch (error) {
        pumped.push({
          runId: summary.runId,
          outcome: "errored",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { attempted: inProgress.length, pumped };
  }

  private async advanceConfigurationUntilSettled(
    connectionId: string,
    secretValues?: Record<string, string>,
  ): Promise<void> {
    const runId = this.configurationRunId();
    const scheduler = this.createScheduler(runId, secretValues, {
      mode: "configuration",
    });
    await this.ensureConfigurationRun(scheduler, runId);
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const document = await this.publishSnapshot(
        await scheduler.snapshot(runId),
      );
      const node = document.state.nodes[connectionId];
      const intervention =
        document.state.interventions?.[`${connectionId}:oauth-callback`];
      if (
        node?.status === "resolved" ||
        node?.status === "errored" ||
        node?.status === "skipped" ||
        intervention?.status === "pending"
      ) {
        return;
      }
      if (document.queue.pending.length + document.queue.running.length === 0) {
        return;
      }
      try {
        await scheduler.processNext();
      } catch (e) {
        if (isRunSaveConflictError(e)) {
          continue;
        }
        throw e;
      }
      await this.publishSnapshot(await scheduler.snapshot(runId));
    }
  }

  private async seedConfiguredManagedConnections(
    runId: string,
    expectedVersion: number,
  ): Promise<void> {
    const configurationRun = await this.stateStore.load(
      this.configurationRunId(),
    );
    if (!configurationRun) return;

    const current = await this.stateStore.load(runId);
    if (!current) return;

    const state = structuredClone(current.state);
    let changed = false;
    for (const connection of this.definition.manifest.managedConnections) {
      const configured = configurationRun.state.nodes[connection.id];
      if (configured?.status !== "resolved") continue;
      if (state.nodes[connection.id]?.status === "resolved") continue;
      state.nodes[connection.id] = {
        status: "resolved",
        kind: "atom",
        value: configured.value,
        deps: [],
        duration_ms: 0,
        attempts: 0,
      };
      changed = true;
    }

    if (!changed) return;

    const saved = await this.stateStore.save(runId, state, expectedVersion);
    if (!saved.ok) throw new Error(`Unable to save run: ${saved.reason}`);
  }

  private async ensureConfigurationRun(
    scheduler: LocalScheduler,
    runId: string,
  ): Promise<void> {
    const snapshot = await scheduler.startRun({
      workflow: this.definition.ref,
      runId,
    });
    if (snapshot.state.trigger !== undefined) {
      await this.publishSnapshot(snapshot);
      return;
    }
    const state = structuredClone(snapshot.state);
    state.trigger = CONFIG_TRIGGER_ID;
    const saved = await this.stateStore.save(runId, state, snapshot.version);
    if (!saved.ok) throw new Error(`Unable to save run: ${saved.reason}`);
    await this.publishSnapshot(await scheduler.snapshot(runId));
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

function isRunSaveConflictError(error: unknown): boolean {
  return (
    error instanceof Error && /Unable to save run: conflict/.test(error.message)
  );
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
  for (const schedule of registry.allSchedules())
    clone.registerSchedule(schedule);
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
      managedConnection: atom.managedConnection,
      fn: atom.fn.toString(),
    })),
    actions: registry.allActions().map((action) => ({
      id: action.id,
      description: action.description,
      fn: action.fn.toString(),
    })),
    schedules: registry.allSchedules().map((schedule) => ({
      id: schedule.id,
      cron: schedule.cron,
      inputId: schedule.inputId,
      payload: schedule.payload,
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
