import { Registry, globalRegistry, type AtomDef } from "./registry";
import { SkipError, WaitError, NotReadyError } from "./errors";
import { isHandle, type Handle } from "./handles";
import type {
  Get,
  RunTrace,
  RunState,
  QueueEvent,
  DispatchResult,
  RuntimeOptions,
  Runtime,
} from "./types";

class RuntimeImpl implements Runtime {
  constructor(private readonly opts: RuntimeOptions) {}

  async process(
    event: QueueEvent,
    state?: RunState
  ): Promise<DispatchResult> {
    const registry = this.opts.registry ?? globalRegistry;
    const session = new RunSession(
      registry,
      this.opts,
      state ?? makeEmptyRunState(event.runId)
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
    private readonly state: RunState
  ) {}

  hasProcessed(eventId: string): boolean {
    return this.state.processedEventIds[eventId] === true;
  }

  markProcessed(eventId: string): void {
    this.state.processedEventIds[eventId] = true;
  }

  handleInputEvent(event: Extract<QueueEvent, { kind: "input" }>): QueueEvent[] {
    const inputDef = this.registry.getInput(event.inputId);
    if (!inputDef) throw new Error(`Unknown input: ${event.inputId}`);

    const validated = inputDef.schema.parse(event.payload);
    this.state.trigger ??= event.inputId;
    this.state.payload ??= validated;
    this.state.inputs[event.inputId] = validated;
    this.state.nodes[event.inputId] = {
      status: "resolved",
      value: validated,
      deps: [],
      duration_ms: 0,
      attempts: 1,
    };

    // On a resumed run, target only steps known to be waiting on this input.
    const targeted = this.state.waiters[event.inputId] ?? [];
    if (targeted.length > 0) {
      delete this.state.waiters[event.inputId];
      return targeted.flatMap(stepId => this.emitStep(stepId));
    }

    // Dynamic deps are not known yet, so the first input for a run fans out to all steps once.
    return this.registry.allAtoms().flatMap(step => this.emitStep(step.id));
  }

  async handleStepEvent(event: Extract<QueueEvent, { kind: "step" }>): Promise<QueueEvent[]> {
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
            if (e instanceof SkipError || e instanceof WaitError) return undefined;
            throw e;
          }
        },
        skip: (): never => {
          throw new SkipError(def.id);
        },
      }
    );

    try {
      const value = await def.fn(get);
      const duration_ms = Date.now() - start;
      this.state.nodes[def.id] = {
        status: "resolved",
        value,
        deps,
        duration_ms,
        attempts: (prev?.attempts ?? 0) + 1,
      };
      this.opts.onStepResolved?.({
        id: def.id, value, duration_ms,
      });
      return value;
    } catch (e) {
      const duration_ms = Date.now() - start;
      if (e instanceof SkipError) {
        this.state.nodes[def.id] = {
          status: "skipped",
          deps,
          duration_ms,
          attempts: (prev?.attempts ?? 0) + 1,
        };
        this.opts.onStepSkipped?.({ id: def.id });
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
        status: "errored", deps, duration_ms,
        attempts: (prev?.attempts ?? 0) + 1,
        error: { message: err.message, stack: err.stack },
      };
      this.opts.onStepErrored?.({ id: def.id, error: err });
      throw e;
    }
  }

  private readValue(readerStepId: string, depId: string): unknown {
    const existing = this.state.nodes[depId];
    if (existing?.status === "resolved") return existing.value;
    if (existing?.status === "skipped") throw new SkipError(depId);
    if (existing?.status === "waiting") {
      this.registerWaiter(depId, readerStepId);
      throw new WaitError(existing.waitingOn!);
    }
    if (existing?.status === "errored") {
      throw Object.assign(new Error(existing.error!.message), {
        stack: existing.error!.stack,
      });
    }
    if (existing?.status === "blocked") {
      this.registerWaiter(depId, readerStepId);
      throw new NotReadyError(depId);
    }

    const inputDef = this.registry.getInput(depId);
    if (inputDef) {
      if (depId in this.state.inputs) {
        return this.state.inputs[depId];
      }
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

  private wakeWaiters(depId: string): QueueEvent[] {
    const waiters = this.state.waiters[depId] ?? [];
    delete this.state.waiters[depId];
    return waiters.flatMap(stepId => this.emitStep(stepId));
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

    // Any node in the registry that never got a record → "not_reached",
    // except unfired non-deferred inputs which are "skipped".
    for (const id of this.registry.allIds()) {
      const rec = this.state.nodes[id];
      if (rec) {
        nodes[id] = { ...rec };
      } else {
        const inputDef = this.registry.getInput(id);
        if (inputDef && inputDef.kind === "input") {
          nodes[id] = { status: "skipped", deps: [], duration_ms: 0, attempts: 0 };
        } else {
          nodes[id] = { status: "not_reached", deps: [], duration_ms: 0, attempts: 0 };
        }
      }
    }

    return {
      runId: this.state.runId,
      trigger: this.state.trigger!,
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
    nodes: {},
    waiters: {},
    processedEventIds: {},
  };
}

export function createRuntime(opts: RuntimeOptions = {}): Runtime {
  return new RuntimeImpl(opts);
}
