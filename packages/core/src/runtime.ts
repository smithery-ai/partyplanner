import { type ZodSchema, z } from "zod";
import { NotReadyError, SkipError, WaitError } from "./errors";
import { type Handle, isHandle } from "./handles";
import { type AtomDef, globalRegistry, type Registry } from "./registry";
import type {
  DispatchResult,
  Get,
  InterventionOptions,
  InterventionRequest,
  QueueEvent,
  RequestIntervention,
  RunState,
  RunTrace,
  Runtime,
  RuntimeOptions,
} from "./types";

class RuntimeImpl implements Runtime {
  constructor(private readonly opts: RuntimeOptions) {}

  async process(event: QueueEvent, state?: RunState): Promise<DispatchResult> {
    const registry = this.opts.registry ?? globalRegistry;
    const session = new RunSession(
      registry,
      this.opts,
      state ?? makeEmptyRunState(event.runId),
    );

    if (session.hasProcessed(event.eventId)) {
      return {
        state: session.snapshot(),
        emitted: [],
        trace: session.buildTrace(),
      };
    }

    const emitted =
      event.kind === "input"
        ? session.handleInputEvent(event)
        : await session.handleStepEvent(event);

    session.markProcessed(event.eventId);

    return {
      state: session.snapshot(),
      emitted,
      trace: session.buildTrace(),
    };
  }
}

class RunSession {
  constructor(
    private readonly registry: Registry,
    private readonly opts: RuntimeOptions,
    private readonly state: RunState,
  ) {}

  hasProcessed(eventId: string): boolean {
    return this.state.processedEventIds[eventId] === true;
  }

  markProcessed(eventId: string): void {
    this.state.processedEventIds[eventId] = true;
  }

  handleInputEvent(
    event: Extract<QueueEvent, { kind: "input" }>,
  ): QueueEvent[] {
    const inputDef = this.registry.getInput(event.inputId);
    if (!inputDef) throw new Error(`Unknown input: ${event.inputId}`);

    const validated = inputDef.schema.parse(event.payload);
    const storedValue = inputDef.secret ? redactedSecretValue() : validated;
    this.state.trigger ??= event.inputId;
    this.state.payload ??= storedValue;
    if (!inputDef.secret) {
      this.state.inputs[event.inputId] = validated;
    }
    this.state.nodes[event.inputId] = {
      status: "resolved",
      value: storedValue,
      deps: [],
      duration_ms: 0,
      attempts: 1,
    };

    // On a resumed run, target steps known to be waiting on this input. Include
    // older waiting records in case they were not added to the waiter index.
    const targeted = this.waitersForInput(event.inputId);
    if (targeted.length > 0) {
      delete this.state.waiters[event.inputId];
      return targeted.flatMap((stepId) => this.emitStep(stepId));
    }

    // Dynamic deps are not known yet, so the first input for a run fans out to all steps once.
    return this.registry.allAtoms().flatMap((step) => this.emitStep(step.id));
  }

  async handleStepEvent(
    event: Extract<QueueEvent, { kind: "step" }>,
  ): Promise<QueueEvent[]> {
    const existing = this.state.nodes[event.stepId];
    if (
      existing?.status === "resolved" ||
      existing?.status === "skipped" ||
      existing?.status === "errored"
    ) {
      return [];
    }

    const atomDef = this.registry.getAtom(event.stepId);
    if (!atomDef) throw new Error(`Unknown step: ${event.stepId}`);

    try {
      await this.runAtom(atomDef);
      return this.wakeWaiters(event.stepId);
    } catch (e) {
      if (e instanceof NotReadyError) {
        return this.emitStep(e.dependencyId);
      }
      if (e instanceof SkipError || e instanceof WaitError) {
        return this.wakeWaiters(event.stepId);
      }
      return this.wakeWaiters(event.stepId);
    }
  }

  private async runAtom(def: AtomDef): Promise<unknown> {
    const start = Date.now();
    const deps: string[] = [];
    const prev = this.state.nodes[def.id];

    const get: Get = Object.assign(
      <T>(source: Handle<T>) => {
        if (!isHandle(source)) {
          throw new Error(`get() called with non-handle value`);
        }
        deps.push(source.__id);
        return this.readValue(def.id, source.__id) as T;
      },
      {
        maybe: <T>(source: Handle<T>) => {
          if (!isHandle(source)) {
            throw new Error(`get.maybe() called with non-handle value`);
          }
          deps.push(source.__id);
          try {
            return this.readValue(def.id, source.__id) as T;
          } catch (e) {
            if (e instanceof SkipError || e instanceof WaitError)
              return undefined;
            throw e;
          }
        },
        skip: (reason?: string): never => {
          throw new SkipError(def.id, reason);
        },
      },
    );
    const requestIntervention: RequestIntervention = <T>(
      key: string,
      schema: ZodSchema<T>,
      opts?: InterventionOptions,
    ) => this.requestIntervention(def.id, key, schema, opts);

    try {
      const value = await def.fn(get, requestIntervention, {
        runId: this.state.runId,
        stepId: def.id,
        interventionId: (key) => interventionId(def.id, key),
      });
      const duration_ms = Date.now() - start;
      this.state.nodes[def.id] = {
        status: "resolved",
        value,
        deps,
        duration_ms,
        attempts: (prev?.attempts ?? 0) + 1,
      };
      this.opts.onStepResolved?.({
        id: def.id,
        value,
        duration_ms,
      });
      return value;
    } catch (e) {
      const duration_ms = Date.now() - start;
      if (e instanceof SkipError) {
        this.state.nodes[def.id] = {
          status: "skipped",
          deps,
          duration_ms,
          skipReason: e.reason,
          attempts: (prev?.attempts ?? 0) + 1,
        };
        this.opts.onStepSkipped?.({ id: def.id, reason: e.reason });
        throw e;
      }
      if (e instanceof WaitError) {
        this.state.nodes[def.id] = {
          status: "waiting",
          deps,
          duration_ms,
          waitingOn: e.inputId,
          attempts: (prev?.attempts ?? 0) + 1,
        };
        this.opts.onStepWaiting?.({ id: def.id, waitingOn: e.inputId });
        throw e;
      }
      if (e instanceof NotReadyError) {
        this.state.nodes[def.id] = {
          status: "blocked",
          deps,
          duration_ms,
          blockedOn: e.dependencyId,
          attempts: (prev?.attempts ?? 0) + 1,
        };
        this.opts.onStepBlocked?.({ id: def.id, blockedOn: e.dependencyId });
        throw e;
      }
      // Real error.
      const err = e as Error;
      this.state.nodes[def.id] = {
        status: "errored",
        deps,
        duration_ms,
        attempts: (prev?.attempts ?? 0) + 1,
        error: { message: err.message, stack: err.stack },
      };
      this.opts.onStepErrored?.({ id: def.id, error: err });
      throw e;
    }
  }

  private readValue(readerStepId: string, depId: string): unknown {
    const inputDef = this.registry.getInput(depId);
    if (inputDef?.secret) {
      const secretValue = this.opts.secretValues?.[depId];
      if (secretValue !== undefined) {
        this.state.nodes[depId] ??= {
          status: "resolved",
          value: redactedSecretValue(),
          deps: [],
          duration_ms: 0,
          attempts: 1,
        };
        return secretValue;
      }
      this.registerWaiter(depId, readerStepId);
      throw new WaitError(depId);
    }

    if (inputDef && depId in this.state.inputs) {
      return this.state.inputs[depId];
    }

    const existing = this.state.nodes[depId];
    if (existing?.status === "resolved") return existing.value;
    if (existing?.status === "skipped")
      throw new SkipError(depId, existing.skipReason);
    if (existing?.status === "waiting") {
      if (existing.waitingOn === undefined) {
        throw new Error(`Waiting node "${depId}" is missing waitingOn`);
      }
      this.registerWaiter(existing.waitingOn, readerStepId);
      throw new WaitError(existing.waitingOn);
    }
    if (existing?.status === "errored") {
      throw Object.assign(new Error(existing.error?.message), {
        stack: existing.error?.stack,
      });
    }
    if (existing?.status === "blocked") {
      this.registerWaiter(depId, readerStepId);
      throw new NotReadyError(depId);
    }

    if (inputDef) {
      if (inputDef.kind === "deferred_input") {
        this.registerWaiter(depId, readerStepId);
        throw new WaitError(depId);
      }
      throw new SkipError(depId);
    }

    const atomDef = this.registry.getAtom(depId);
    if (!atomDef) throw new Error(`Unknown id: ${depId}`);

    this.registerWaiter(depId, readerStepId);
    throw new NotReadyError(depId);
  }

  private registerWaiter(depId: string, stepId: string): void {
    const list = this.state.waiters[depId] ?? [];
    if (!list.includes(stepId)) list.push(stepId);
    this.state.waiters[depId] = list;
  }

  private requestIntervention<T>(
    stepId: string,
    key: string,
    schema: ZodSchema<T>,
    opts?: InterventionOptions,
  ): T {
    const id = interventionId(stepId, key);
    const responses = this.state.interventionResponses ?? {};
    if (Object.hasOwn(responses, id)) {
      return schema.parse(responses[id]);
    }

    this.state.interventions ??= {};
    this.state.interventionResponses ??= {};
    this.state.interventions[id] ??= makeInterventionRequest(
      id,
      stepId,
      key,
      schema,
      opts,
    );
    this.registerWaiter(id, stepId);
    throw new WaitError(id);
  }

  private wakeWaiters(depId: string): QueueEvent[] {
    const waiters = this.state.waiters[depId] ?? [];
    delete this.state.waiters[depId];
    return waiters.flatMap((stepId) => this.emitStep(stepId));
  }

  private waitersForInput(inputId: string): string[] {
    const waiters = new Set(this.state.waiters[inputId] ?? []);
    for (const [stepId, record] of Object.entries(this.state.nodes)) {
      if (record.status === "waiting" && record.waitingOn === inputId) {
        waiters.add(stepId);
      }
    }
    return [...waiters];
  }

  private emitStep(stepId: string): QueueEvent[] {
    const rec = this.state.nodes[stepId];
    if (
      rec?.status === "resolved" ||
      rec?.status === "skipped" ||
      rec?.status === "errored"
    ) {
      return [];
    }
    const ev: QueueEvent = {
      kind: "step",
      eventId: crypto.randomUUID(),
      runId: this.state.runId,
      stepId,
    };
    this.opts.onEventEmitted?.(ev);
    return [ev];
  }

  snapshot(): RunState {
    return structuredClone(this.state);
  }

  buildTrace(): RunTrace {
    const nodes: RunTrace["nodes"] = {};
    const { trigger } = this.state;

    if (trigger === undefined) {
      throw new Error("Cannot build trace without a trigger");
    }

    // Any node in the registry that never got a record → "not_reached",
    // except unfired non-deferred inputs which are "skipped".
    for (const id of this.registry.allIds()) {
      const rec = this.state.nodes[id];
      if (rec) {
        nodes[id] = { ...rec };
      } else {
        const inputDef = this.registry.getInput(id);
        if (inputDef && inputDef.kind === "input") {
          nodes[id] = {
            status: "skipped",
            deps: [],
            duration_ms: 0,
            attempts: 0,
          };
        } else {
          nodes[id] = {
            status: "not_reached",
            deps: [],
            duration_ms: 0,
            attempts: 0,
          };
        }
      }
    }

    return {
      runId: this.state.runId,
      trigger,
      payload: this.state.payload,
      startedAt: this.state.startedAt,
      completedAt: Date.now(),
      nodes,
    };
  }
}

function makeEmptyRunState(runId: string): RunState {
  return {
    runId,
    startedAt: Date.now(),
    inputs: {},
    interventions: {},
    interventionResponses: {},
    nodes: {},
    waiters: {},
    processedEventIds: {},
  };
}

export function createRuntime(opts: RuntimeOptions = {}): Runtime {
  return new RuntimeImpl(opts);
}

function redactedSecretValue(): string {
  return "[secret]";
}

function interventionId(stepId: string, key: string): string {
  return `${stepId}:${key}`;
}

function makeInterventionRequest<T>(
  id: string,
  stepId: string,
  key: string,
  schema: ZodSchema<T>,
  opts?: InterventionOptions,
): InterventionRequest {
  return {
    id,
    stepId,
    key,
    status: "pending",
    schema: z.toJSONSchema(schema),
    title: opts?.title,
    description: opts?.description,
    action: opts?.action,
    createdAt: Date.now(),
  };
}
