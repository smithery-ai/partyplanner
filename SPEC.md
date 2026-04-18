# Reactive Workflow SDK — Implementation Plan

## Goal

Build a standalone TypeScript SDK that provides the `input()` / `atom()` / `get()` API for defining reactive workflows, plus a queue-driven runtime that processes one event at a time. No Cloudflare, no Durable Objects, no Dynamic Workers — this is a pure library that runs anywhere JavaScript runs (Node, Bun, Deno, Workers, browsers).

By the end of this plan, `npm test` against the five example workflows in the appendix should pass.

---

## Design Principles

1. **Names are optional for steps, required for inputs.** Inputs are externally addressable (webhooks route to them), so they need stable IDs. Executable nodes are created with `atom()`, but conceptually they are workflow steps; the runtime can generate stable IDs by hashing function source when the user doesn't provide a name.

2. **Dependencies are discovered at runtime, not declared.** Users call `get(other)` inside a step and the runtime records the call. No dependency arrays, no static analysis.

3. **Skip vs Wait vs Blocked are different concepts.** `SkipError` means "this branch doesn't apply to this payload, ignore it." `WaitError` means "this branch is blocked on a deferred input, pause it until that input arrives." `NotReadyError` means "this branch depends on another step that has not materialized yet, enqueue that step and retry later."

4. **Snapshots are full run state, not just values.** To resume precisely, the runtime must persist resolved values, terminal statuses, waiter lists, and processed input identities. A plain `Map<nodeId, value>` is not enough.

5. **The queue is external; the runtime is a state transition function.** The SDK does not own a broker. It consumes one queue event plus the current persisted run state, and returns an updated run state plus follow-up queue events to publish.

6. **Side effects in user code are the user's problem.** The SDK doesn't guarantee exactly-once across queue redelivery or crashes. Steps that perform side effects should be idempotent.

7. **No build step required for the core API.** The SDK is plain TypeScript that works with `tsc` or `esbuild`. A build plugin for name inference is a potential future addition, not a requirement.

---

## Public API

```ts
import { input, atom, createRuntime } from "@rxwf/core";
import type { Runtime, RunTrace, Get } from "@rxwf/core";
```

### `input(name, schema, opts?)`

```ts
function input<T>(
  name: string,
  schema: ZodSchema<T>,
  opts?: InputOpts
): Input<T>;

input.deferred = function <T>(
  name: string,
  schema: ZodSchema<T>,
  opts?: InputOpts
): DeferredInput<T>;

type InputOpts = {
  description?: string;
};
```

- `name` is required and must be unique within the registry.
- `schema` is a Zod schema used to validate the payload when the input fires.
- `description` is optional human text for UI tooltips and docs.

### `atom(fn, opts?)`

```ts
function atom<T>(
  fn: (get: Get) => Promise<T> | T,
  opts?: AtomOpts
): Atom<T>;

type AtomOpts = {
  name?: string;           // explicit stable ID (recommended for production)
  description?: string;    // human text for UI
};
```

- `fn` receives a synchronous `get` function and returns (or resolves to) the step's value.
- `get()` only reads already-materialized dependency values. It never computes dependencies inline.
- If `get(stepDep)` is called before that step has materialized, it throws `NotReadyError`. The runtime records the dependency edge, enqueues `stepDep`, and retries the current step only after `stepDep` reaches a terminal state.
- Because a blocked step may be re-run later from the queue, dependency reads should happen before side effects or long async work.
- If `name` is omitted, the runtime assigns an ID by hashing `fn.toString()`.
  - Stable across deploys if the function body doesn't change.
  - Changes when the function is edited — invalidating any prior persisted result for that step (intentional).
- If `name` is provided, it must be unique within the registry.

### `Get` interface

```ts
interface Get {
  /** Read a dependency synchronously. Throws SkipError / WaitError / NotReadyError. */
  <T>(source: Input<T> | DeferredInput<T> | Atom<T>): T;

  /** Read optionally. Returns undefined on Skip/Wait, but still throws NotReadyError. */
  maybe<T>(source: Input<T> | DeferredInput<T> | Atom<T>): T | undefined;

  /** Explicitly skip the current step. */
  skip(reason?: string): never;
}
```

- `get()` is synchronous and only returns already-resolved values from this run state.
- If the dependency is not resolved yet, `get()` throws `NotReadyError`. The runtime catches that, records a waiter edge, and emits follow-up step work.
- The canonical usage is `const value = get(dep)`.

### `createRuntime(options?)`

```ts
function createRuntime(options?: RuntimeOptions): Runtime;

type RuntimeOptions = {
  registry?: Registry;                        // defaults to globalRegistry
  onEventEmitted?: (ev: QueueEvent) => void;
  onStepResolved?: (ev: StepResolvedEvent) => void;
  onStepErrored?: (ev: StepErroredEvent) => void;
  onStepSkipped?: (ev: StepSkippedEvent) => void;
  onStepWaiting?: (ev: StepWaitingEvent) => void;
  onStepBlocked?: (ev: StepBlockedEvent) => void;
};

type QueueEvent =
  | { kind: "input"; eventId: string; runId: string; inputId: string; payload: unknown }
  | { kind: "step"; eventId: string; runId: string; stepId: string };

type DispatchResult = {
  state: RunState;
  emitted: QueueEvent[];
  trace: RunTrace;
};

interface Runtime {
  process(event: QueueEvent, state?: RunState): Promise<DispatchResult>;
}
```

The runtime consumes one queue event at a time. The caller persists `state` and publishes `emitted` into whatever queue they want.

### `RunState`

```ts
type RunState = {
  runId: string;
  startedAt: number;
  trigger?: string;
  payload?: unknown;
  inputs: Record<string, unknown>;
  nodes: Record<string, {
    status: NodeStatus;
    value?: unknown;
    error?: { message: string; stack?: string };
    deps: string[];
    duration_ms: number;
    blockedOn?: string;
    waitingOn?: string;
    skipReason?: string;
    attempts: number;
  }>;
  waiters: Record<string, string[]>;     // depId -> directly blocked stepIds
  processedEventIds: Record<string, true>;
};
```

### `RunTrace`

```ts
type NodeStatus =
  | "resolved"
  | "skipped"
  | "waiting"
  | "blocked"
  | "errored"
  | "not_reached";

type RunTrace = {
  runId: string;
  trigger: string;
  payload: unknown;
  startedAt: number;
  completedAt: number;
  nodes: Record<string, {
    status: NodeStatus;
    value?: unknown;
    error?: { message: string; stack?: string };
    deps: string[];
    duration_ms: number;
    blockedOn?: string;
    waitingOn?: string;
    skipReason?: string;
    attempts: number;
  }>;
};
```

---

## Internal Architecture

### File layout

```
packages/core/
├── src/
│   ├── index.ts          ← re-exports the public API
│   ├── input.ts          ← input() and input.deferred()
│   ├── atom.ts           ← atom()
│   ├── handles.ts        ← Handle type + factory
│   ├── registry.ts       ← Registry class + globalRegistry singleton
│   ├── runtime.ts        ← Runtime class, queue dispatch algorithm
│   ├── errors.ts         ← SkipError, WaitError, NotReadyError
│   ├── hash.ts           ← FNV-1a hash for auto-generated atom IDs
│   └── types.ts          ← shared public types
├── test/
│   ├── example-1-linear.test.ts
│   ├── example-2-multi-input.test.ts
│   ├── example-3-branching.test.ts
│   ├── example-4-parallel-dedup.test.ts
│   ├── example-5-deferred.test.ts
│   └── helpers.ts        ← test utilities (clear registry, assert trace shape)
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

### Handle type

Every `input()` / `input.deferred()` / `atom()` call returns a `Handle`. The runtime uses the internal properties to identify the source; the user never reads these directly.

```ts
// handles.ts
export const HANDLE = Symbol.for("@rxwf/handle");

export type HandleKind = "input" | "deferred_input" | "atom";

export interface Handle<T = unknown> {
  readonly [HANDLE]: true;
  readonly __id: string;
  readonly __kind: HandleKind;
  readonly __type?: T;              // phantom type, compile-time only
}

export type Input<T> = Handle<T> & { readonly __kind: "input" };
export type DeferredInput<T> = Handle<T> & { readonly __kind: "deferred_input" };
export type Atom<T> = Handle<T> & { readonly __kind: "atom" };

export function makeHandle<T>(kind: HandleKind, id: string): Handle<T> {
  return Object.freeze({ [HANDLE]: true as const, __id: id, __kind: kind });
}

export function isHandle(x: unknown): x is Handle {
  return typeof x === "object" && x !== null && (x as any)[HANDLE] === true;
}
```

### Registry

```ts
// registry.ts
import type { ZodSchema } from "zod";

export type InputDef = {
  kind: "input" | "deferred_input";
  id: string;
  schema: ZodSchema<unknown>;
  description?: string;
};

export type AtomDef = {
  kind: "atom";
  id: string;
  fn: (get: Get) => unknown;
  description?: string;
};

export class Registry {
  private _inputs = new Map<string, InputDef>();
  private _atoms = new Map<string, AtomDef>();

  registerInput(def: InputDef): void {
    if (this._inputs.has(def.id) || this._atoms.has(def.id)) {
      throw new Error(`Duplicate registry ID: ${def.id}`);
    }
    this._inputs.set(def.id, def);
  }

  registerAtom(def: AtomDef): void {
    if (this._atoms.has(def.id) || this._inputs.has(def.id)) {
      throw new Error(`Duplicate registry ID: ${def.id}`);
    }
    this._atoms.set(def.id, def);
  }

  getInput(id: string): InputDef | undefined { return this._inputs.get(id); }
  getAtom(id: string): AtomDef | undefined { return this._atoms.get(id); }

  allInputs(): InputDef[] { return [...this._inputs.values()]; }
  allAtoms(): AtomDef[] { return [...this._atoms.values()]; }
  allIds(): string[] { return [...this._inputs.keys(), ...this._atoms.keys()]; }

  clear(): void {
    this._inputs.clear();
    this._atoms.clear();
  }
}

export const globalRegistry = new Registry();
```

Both `input()` and `atom()` register into `globalRegistry` by default. Tests call `globalRegistry.clear()` between cases to prevent state leakage.

### Errors

```ts
// errors.ts
export class SkipError extends Error {
  readonly kind = "skip" as const;
  constructor(public stepId: string) {
    super(`Step "${stepId}" skipped`);
    this.name = "SkipError";
  }
}

export class WaitError extends Error {
  readonly kind = "wait" as const;
  constructor(public inputId: string) {
    super(`Waiting for input "${inputId}"`);
    this.name = "WaitError";
  }
}

export class NotReadyError extends Error {
  readonly kind = "not_ready" as const;
  constructor(public dependencyId: string) {
    super(`Dependency "${dependencyId}" is not resolved yet`);
    this.name = "NotReadyError";
  }
}

export function isControlFlowError(
  e: unknown
): e is SkipError | WaitError | NotReadyError {
  return e instanceof SkipError || e instanceof WaitError || e instanceof NotReadyError;
}
```

### Hash for auto-generated IDs

```ts
// hash.ts
// FNV-1a 32-bit. Not cryptographic — just needs to be stable and short.
export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
```

Atom IDs generated from function source are prefixed with `atom_` for readability in traces: `atom_7a3f2b91`.

### input() implementation

```ts
// input.ts
import type { ZodSchema } from "zod";
import { globalRegistry } from "./registry";
import { makeHandle, type Input, type DeferredInput } from "./handles";

export function input<T>(
  name: string,
  schema: ZodSchema<T>,
  opts?: { description?: string }
): Input<T> {
  globalRegistry.registerInput({
    kind: "input",
    id: name,
    schema: schema as ZodSchema<unknown>,
    description: opts?.description,
  });
  return makeHandle<T>("input", name) as Input<T>;
}

input.deferred = function deferred<T>(
  name: string,
  schema: ZodSchema<T>,
  opts?: { description?: string }
): DeferredInput<T> {
  globalRegistry.registerInput({
    kind: "deferred_input",
    id: name,
    schema: schema as ZodSchema<unknown>,
    description: opts?.description,
  });
  return makeHandle<T>("deferred_input", name) as DeferredInput<T>;
};
```

### atom() implementation

```ts
// atom.ts
import { globalRegistry } from "./registry";
import { makeHandle, type Atom } from "./handles";
import { hashString } from "./hash";
import type { Get } from "./types";

export type AtomOpts = {
  name?: string;
  description?: string;
};

export function atom<T>(
  fn: (get: Get) => Promise<T> | T,
  opts?: AtomOpts
): Atom<T> {
  const id = opts?.name ?? `atom_${hashString(fn.toString())}`;
  globalRegistry.registerAtom({
    kind: "atom",
    id,
    fn: fn as (get: Get) => unknown,
    description: opts?.description,
  });
  return makeHandle<T>("atom", id) as Atom<T>;
}
```

### Runtime

The heart of the SDK. One call to `runtime.process(...)` handles exactly one queue event. The durable state lives outside the runtime and is passed back in on the next call.

```ts
// runtime.ts
import { Registry, globalRegistry, type AtomDef } from "./registry";
import { SkipError, WaitError, NotReadyError } from "./errors";
import { isHandle, type Handle } from "./handles";
import type {
  Get,
  RunTrace,
  RunState,
  NodeStatus,
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
      existing?.status === "waiting" ||
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
        skip: (reason?: string): never => {
          throw new SkipError(def.id, reason);
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
    if (existing?.status === "waiting") throw new WaitError(existing.waitingOn!);
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
      rec?.status === "waiting" ||
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

    // Any node in the registry that never got a record → "not_reached".
    for (const id of this.registry.allIds()) {
      const rec = this.state.nodes[id];
      if (rec) {
        nodes[id] = { ...rec };
      } else {
        nodes[id] = { status: "not_reached", deps: [], duration_ms: 0, attempts: 0 };
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
```

### Key algorithm notes

- **`get()` is a synchronous read, not a resolver.** It returns a value only if the dependency is already materialized in persisted run state. Otherwise it throws `SkipError`, `WaitError`, or `NotReadyError`.

- **Each queue message executes one step at most once.** `runtime.process(...)` handles one input event or one step event and returns follow-up events to publish.

- **Blocked steps register direct reverse edges.** If `b` does `get(a)` before `a` is materialized, the runtime records `waiters[a].add("b")`, emits `{ kind: "step", stepId: "a" }`, and marks `b` as `blocked`. Waiters are direct only, never transitive.

- **Resolving or terminalizing a dependency wakes only its dependents.** When `a` becomes `resolved`, `skipped`, `waiting`, or `errored`, the runtime emits only the steps recorded in `waiters[a]`. It does not rescan the whole graph.

- **The first input for a run still needs one broad fan-out.** Because dependency edges are dynamic and discovered at runtime, the first input event for a fresh run enqueues every step once. After that first discovery phase, scheduling becomes targeted.

- **Duplicate delivery is idempotent.** `eventId` is part of every queue event. Re-delivering an already-processed input or step event is a no-op.

- **Control-flow errors bubble naturally once a dependency has a terminal state.** A skip in step `A` becomes a skip in any step that does `get(A)`. A deferred-input wait does the same. `get.maybe()` converts skip/wait into `undefined`, but still rethrows `NotReadyError`.

- **Dependency reads should happen before side effects.** If a step performs side effects and only then hits `NotReadyError`, the step may be re-run later from a follow-up queue event.

- **Input validation happens when the input event arrives.** The payload is Zod-parsed before it is written into run state.

---

## Testing

Use Vitest. Each example from the appendix gets its own test file. Shared helpers:

```ts
// test/helpers.ts
import { globalRegistry } from "../src/registry";
import { beforeEach } from "vitest";

export function resetRegistry() {
  beforeEach(() => globalRegistry.clear());
}

export async function runToIdle(
  runtime: Runtime,
  seed: QueueEvent,
  state?: RunState
): Promise<{ state: RunState; trace: RunTrace }> {
  const queue = [seed];
  let current = state;
  let trace!: RunTrace;

  while (queue.length > 0) {
    const event = queue.shift()!;
    const result = await runtime.process(event, current);
    current = result.state;
    trace = result.trace;
    queue.push(...result.emitted);
  }

  return { state: current!, trace };
}

export function assertResolved(trace: RunTrace, id: string, expectedValue?: unknown) {
  const a = trace.nodes[id];
  if (!a) throw new Error(`No record for "${id}"`);
  if (a.status !== "resolved") {
    throw new Error(`Expected "${id}" resolved, got "${a.status}" (error: ${a.error?.message})`);
  }
  if (expectedValue !== undefined) {
    expect(a.value).toEqual(expectedValue);
  }
}

export function assertSkipped(trace: RunTrace, id: string) {
  expect(trace.nodes[id]?.status).toBe("skipped");
}

export function assertWaiting(trace: RunTrace, id: string, waitingOn?: string) {
  expect(trace.nodes[id]?.status).toBe("waiting");
  if (waitingOn) expect(trace.nodes[id]?.waitingOn).toBe(waitingOn);
}
```

Each example file defines its workflow in `beforeEach` (after clearing the registry), seeds an initial queue event, and drains an in-memory queue until idle.

---

## Implementation Order

1. **handles.ts, errors.ts, hash.ts** — pure, no dependencies. ~30 min.
2. **registry.ts** — simple class with add/get/clear. ~20 min.
3. **input.ts, atom.ts** — thin wrappers over registry + handle factory. ~20 min.
4. **runtime.ts** — the main event. ~2 hours including iterating against tests.
5. **test/example-1-linear.test.ts** — verify the happy path works. If this passes, the core is sound.
6. **test/example-2** through **example-5** — each exercises a different runtime behavior. Expect minor runtime bug fixes as edge cases surface.
7. **index.ts** — public barrel export.
8. **Package scaffolding** — `package.json`, `tsconfig.json`, `vitest.config.ts`.

Estimated total: one focused day.

---

## Deliberately Out of Scope

- Persistence (no DO, no disk, no network)
- Queue transport, broker integration, and delivery semantics
- Timeouts (user puts their own `AbortController` in step code if needed)
- Cancellation (if a run starts, it runs to completion; no `runtime.cancel()`)
- Observability (the event callbacks are the hook; no built-in logger or metrics)
- Dynamic code loading (the registry is populated by imports, not by string eval)
- Schema migration (changing schemas or step IDs can invalidate old persisted run snapshots — that's fine for v0)
- Cycle detection / deadlock diagnostics (a cycle can leave steps permanently `blocked`; add explicit reporting later)
- Name inference from variable bindings (future build plugin)

---

## Appendix: The Five Examples

### Example 1 — Simple linear pipeline

```js
const slack = input("slack", z.object({
  message: z.string(),
  channel: z.string(),
}));

const classify = atom((get) => {
  const msg = get(slack);
  return msg.message.toLowerCase().includes("urgent") ? "urgent" : "normal";
}, { name: "classify" });

const format = atom((get) => {
  const priority = get(classify);
  const msg = get(slack);
  return `[${priority.toUpperCase()}] ${msg.channel}: ${msg.message}`;
}, { name: "format" });
```

Assertions:
- Seed one `{ kind: "input", eventId, inputId: "slack" }` event, drain queue, and all three resolve.
- `trace.nodes.format.deps` includes both `classify` and `slack`.

### Example 2 — Multi-input with `get.maybe`

```js
const slack = input("slack", z.object({ text: z.string() }));
const email = input("email", z.object({ body: z.string() }));

const extractText = atom((get) => {
  const s = get.maybe(slack);
  const e = get.maybe(email);
  return s?.text ?? e?.body ?? get.skip();
}, { name: "extractText" });

const wordCount = atom((get) => {
  const text = get(extractText);
  return text.split(/\s+/).length;
}, { name: "wordCount" });
```

Assertions:
- Seed `slack` input event, drain queue → slack resolved, email skipped, extractText resolved, wordCount resolved.
- Seed `email` input event, drain queue → email resolved, slack skipped, extractText resolved, wordCount resolved.

### Example 3 — Branching with skip propagation

```js
const github = input("github", z.object({ repo: z.string(), diff: z.string() }));
const slack = input("slack", z.object({ message: z.string() }));

const codeReview = atom((get) => {
  const pr = get(github);
  return { suggestions: pr.diff.split("\n").length };
}, { name: "codeReview" });

const postReview = atom((get) => {
  const review = get(codeReview);
  return `Posted review with ${review.suggestions} suggestions`;
}, { name: "postReview" });

const echo = atom((get) => {
  const msg = get(slack);
  return `echo: ${msg.message}`;
}, { name: "echo" });
```

Assertions:
- Seed `github` input event, drain queue → codeReview resolved, postReview resolved, echo skipped, slack skipped.
- Seed `slack` input event, drain queue → echo resolved, github skipped, codeReview skipped, postReview skipped.

### Example 4 — Parallel dedup

```js
const order = input("order", z.object({
  orderId: z.string(),
  items: z.array(z.string()),
}));

let enrichCallCount = 0;

const enriched = atom(async (get) => {
  const o = get(order);
  enrichCallCount++;
  await new Promise(r => setTimeout(r, 50));
  return { ...o, total: o.items.length * 10 };
}, { name: "enriched" });

const notifyWarehouse = atom((get) => {
  const e = get(enriched);
  return `warehouse notified for ${e.orderId}`;
}, { name: "notifyWarehouse" });

const sendReceipt = atom((get) => {
  const e = get(enriched);
  return `receipt sent for ${e.orderId}`;
}, { name: "sendReceipt" });
```

Assertions:
- `enrichCallCount === 1` after the run.
- `notifyWarehouse` and `sendReceipt` both block on `enriched`, but only one `{ kind: "step", stepId: "enriched" }` event is emitted.

### Example 5 — Deferred input (durable workflow)

```js
const expense = input("expense", z.object({
  amount: z.number(),
  description: z.string(),
}));

const approval = input.deferred("approval", z.object({
  approved: z.boolean(),
}));

const assessment = atom((get) => {
  const e = get(expense);
  return e.amount > 1000 ? "high" : "low";
}, { name: "assessment" });

const submit = atom((get) => {
  const e = get(expense);
  const a = get(assessment);
  const decision = get(approval);
  if (!decision.approved) return get.skip();
  return `submitted: ${e.description} ($${e.amount}, ${a} risk)`;
}, { name: "submit" });
```

Assertions:
- Run 1: seed `expense` input event and drain queue. `expense` + `assessment` resolve, `submit` ends `waiting` on `approval`, and the run state records `submit` as a waiter of `approval`.
- Persist the full `RunState`, not just resolved values.
- Run 2: seed `approval` input event with the prior `RunState`. The runtime should emit only `submit`, not `assessment`, and `submit` should resolve with the expected string.
- Assessment should NOT have re-executed (verify by making assessment's fn have a side effect counter).
