# Hylo Production Path: Portable Runtime Adapters

## Goal

Make the current workflow model production-shaped without committing to Cloudflare yet.

The immediate target is:

- keep `packages/core` portable,
- run workflow orchestration and queueing in the browser for now,
- abstract state, queueing, scheduling, and events behind small interfaces,
- execute locally in the browser during development,
- optionally execute atom work through a stateless serverless backend,
- make Cloudflare Durable Objects + Queues a later adapter, not a rewrite.

The current `/graph` backend is useful as a demo shell, but it mixes several concerns:

- workflow source loading,
- state ownership,
- scheduling,
- atom execution,
- graph construction.

This spec splits those concerns into explicit interfaces.

## Architecture Shape

```text
Workflow Definition
  |
  v
Runtime Kernel (`packages/core`)
  |
  v
Scheduler
  |             |              |
  v             v              v
StateStore    WorkQueue      EventSink
```

For now:

```text
StateStore = in-memory / browser storage
WorkQueue  = browser-managed queue
EventSink  = React state / browser event stream
```

Near term with serverless execution:

```text
StateStore = browser storage
WorkQueue  = browser-managed queue
EventSink  = React state / browser event stream
Executor   = serverless function per atom attempt
```

Later on Cloudflare-managed orchestration:

```text
StateStore = Durable Object storage
WorkQueue  = Cloudflare Queue
EventSink  = Durable Object WebSocket/SSE
```

The workflow semantics should not change between those deployments.

## Core Principle

`packages/core` should answer:

> Given a workflow registry, one event, and a run snapshot, what changed?

It should not know where state is stored, how work is queued, or how UI updates are delivered.

The scheduler should answer:

> Given the runtime result, what state should be persisted, what work should be queued, and what events should observers receive?

## Current Model To Preserve

Keep the existing API:

```ts
const provider = input("provider", schema);
const approval = input.deferred("approval", schema);

const assess = atom((get) => {
  const p = get(provider);
  return p.kind;
}, { name: "assess" });
```

Keep current control-flow semantics:

- missing normal input -> `skipped`
- missing deferred input -> `waiting`
- unresolved atom dependency -> `blocked`
- explicit `get.skip()` -> `skipped`
- successful atom -> `resolved`
- thrown error -> `errored`

Add scheduler-visible lifecycle states:

```ts
type ExecutionStatus =
  | "not_reached"
  | "queued"
  | "running"
  | "resolved"
  | "skipped"
  | "waiting"
  | "blocked"
  | "errored";
```

`queued` and `running` may live either inside `NodeStatus` or as a separate `execution` field. The important part is that the UI can observe them.

## Portable Interfaces

### StateStore

The authoritative state store for a run.

```ts
export interface StateStore {
  load(runId: string): Promise<RunState | undefined>;
  save(runId: string, state: RunState, expectedVersion?: number): Promise<SaveResult>;
}

export type SaveResult =
  | { ok: true; version: number }
  | { ok: false; reason: "conflict" | "missing" };
```

For the client/local adapter, this can be a `Map` or `localStorage` wrapper.

For Cloudflare, this becomes a Durable Object method.

### WorkQueue

The queue used to schedule input and atom work.

```ts
export interface WorkQueue {
  enqueue(event: QueueEvent): Promise<void>;
  enqueueMany(events: QueueEvent[]): Promise<void>;
  dequeue?(): Promise<QueueEvent | undefined>;
  peek?(): Promise<readonly QueueEvent[]>;
  size?(): Promise<number>;
}
```

For the browser adapter, this is an in-memory or IndexedDB-backed FIFO controlled by the frontend.

For Cloudflare, this is a Cloudflare Queue producer.

The browser queue is not a compromise; it is the intended first implementation. It lets the UI show exactly what is queued, what is currently running, what is blocked, and what will run next.

The queue should be observable:

```ts
export type QueueSnapshot = {
  pending: QueueEvent[];
  running: QueueEvent[];
  completed: QueueEvent[];
  failed: QueueEvent[];
};
```

The frontend can render this directly as a queue/timeline panel.

### EventSink

The event stream consumed by the UI.

```ts
export interface EventSink {
  publish(event: RunEvent): Promise<void>;
  publishMany(events: RunEvent[]): Promise<void>;
}
```

For the client/local adapter, this can update React state directly or dispatch browser events.

For Cloudflare, this broadcasts from a Durable Object over WebSocket/SSE.

### WorkflowLoader

Loads an immutable workflow definition.

```ts
export interface WorkflowLoader {
  load(ref: WorkflowRef): Promise<WorkflowDefinition>;
}

export type WorkflowRef = {
  workflowId: string;
  version: string;
  codeHash?: string;
};
```

For now, the loader can point at bundled modules or the current client-side registry.

Later, Cloudflare can load static bundles, manifests, or Dynamic Workers.

### Scheduler

Coordinates state, queue, and events.

```ts
export interface Scheduler {
  startRun(request: StartRunRequest): Promise<RunSnapshot>;
  submitInput(request: SubmitInputRequest): Promise<RunSnapshot>;
  processNext?(): Promise<void>; // browser/local adapter
  drain?(): Promise<void>;       // browser/local adapter
  processEvent(event: QueueEvent): Promise<void>;
  snapshot(runId: string): Promise<RunSnapshot>;
}
```

The local scheduler and Cloudflare scheduler should share the same high-level algorithm.

### Executor

The scheduler decides what should run. The executor decides where one atom attempt runs.

```ts
export interface Executor {
  executeAtom(request: ExecuteAtomRequest): Promise<AtomExecutionResult>;
}

export type ExecuteAtomRequest = {
  runId: string;
  workflow: WorkflowRef;
  nodeId: string;
  state: RunState;
};
```

Initial executors:

- `BrowserExecutor`: runs atom code directly in the browser.
- `ServerlessExecutor`: POSTs one atom attempt to a backend endpoint and returns the result.

Later executors:

- `CloudflareQueueExecutor`: lets Cloudflare Queue consumers run atom attempts.
- `DynamicWorkerExecutor`: runs runtime-authored atom code in a sandbox.

This keeps browser queueing independent from execution location.

## Run Events

Use a small event model from the start.

```ts
export type RunEvent =
  | { type: "run_started"; runId: string; at: number }
  | { type: "input_received"; runId: string; inputId: string; at: number }
  | { type: "node_queued"; runId: string; nodeId: string; at: number }
  | { type: "node_started"; runId: string; nodeId: string; at: number }
  | { type: "edge_discovered"; runId: string; source: string; target: string; at: number }
  | { type: "node_resolved"; runId: string; nodeId: string; at: number }
  | { type: "node_skipped"; runId: string; nodeId: string; at: number }
  | { type: "node_waiting"; runId: string; nodeId: string; waitingOn: string; at: number }
  | { type: "node_blocked"; runId: string; nodeId: string; blockedOn: string; at: number }
  | { type: "node_errored"; runId: string; nodeId: string; message: string; at: number }
  | { type: "run_completed"; runId: string; at: number }
  | { type: "run_waiting"; runId: string; waitingOn: string[]; at: number };
```

These events are UI-facing and portable. The event transport can change later.

## Run Snapshot

The UI should render from snapshots plus events.

```ts
export type RunSnapshot = {
  runId: string;
  workflow: WorkflowRef;
  status: "created" | "running" | "waiting" | "completed" | "failed" | "canceled";
  nodes: GraphNode[];
  edges: GraphEdge[];
  state: RunState;
  version: number;
};
```

For now this can be held in React state. Later it can come from `GET /runs/:runId/graph`.

## Local First Implementation

The first production-shaped implementation should be local/client-side.

```text
packages/core
  runtime kernel, types, registry

packages/runtime
  Scheduler
  StateStore interface
  WorkQueue interface
  EventSink interface
  Executor interface
  in-memory adapters

apps/client
  uses browser Scheduler
  owns WorkQueue
  renders RunSnapshot + RunEvent stream
```

Recommended local adapters:

```ts
class MemoryStateStore implements StateStore {
  private states = new Map<string, { version: number; state: RunState }>();
}

class MemoryWorkQueue implements WorkQueue {
  private events: QueueEvent[] = [];
}

class BrowserEventSink implements EventSink {
  constructor(private emit: (event: RunEvent) => void) {}
}
```

This gives the UI the right production behavior while avoiding infrastructure. The browser should be able to pause, step, drain, retry, and inspect the queue.

## Browser-Managed Queue Mode

This is the primary near-term mode.

The browser owns:

- run state,
- work queue,
- scheduling decisions,
- event log,
- graph snapshot,
- timeline visualization.

The backend, if used, owns only:

- executing one atom attempt,
- returning the atom result,
- enforcing server-side secrets/capabilities for that atom.

This means the frontend can be rich and deterministic. It can show:

- queued events,
- active atom attempts,
- dependency reads,
- newly discovered edges,
- blocked nodes,
- deferred input gates,
- retries,
- execution timing,
- final graph state.

### Browser Queue Controls

The UI should support:

- `Step`: process one queued event.
- `Drain`: process until idle or waiting.
- `Pause`: stop after current atom finishes.
- `Retry`: requeue an errored/failed event.
- `Reset`: clear run state and queue.
- `Inspect`: view raw event, node record, deps, and output.

These controls should call the same `Scheduler` methods that later server-backed execution uses.

### Serverless Atom Execution

When an atom cannot run in the browser because it needs secrets, trusted network access, or server-only bindings, the browser still keeps the queue. It sends only the active atom attempt to the backend.

```text
Browser WorkQueue
  |
  v
Scheduler.processNext()
  |
  v
ServerlessExecutor.executeAtom()
  |
  v
POST /execute-atom
  |
  v
Backend runs one atom and returns result
```

Suggested endpoint:

```http
POST /execute-atom
Content-Type: application/json
```

```ts
type ExecuteAtomRequest = {
  runId: string;
  workflow: WorkflowRef;
  nodeId: string;
  state: RunState;
};

type AtomExecutionResult =
  | { status: "resolved"; value: unknown; deps: string[]; duration_ms: number }
  | { status: "skipped"; deps: string[]; duration_ms: number }
  | { status: "waiting"; waitingOn: string; deps: string[]; duration_ms: number }
  | { status: "blocked"; blockedOn: string; deps: string[]; duration_ms: number }
  | { status: "errored"; message: string; stack?: string; deps: string[]; duration_ms: number };
```

The backend should not own the queue in this mode. It should be stateless and idempotent from the browser's perspective.

Security note: do not send secret-bearing state or untrusted workflow code to a generic executor without a trust model. For early development, first-party workflows and local state are acceptable.

## Scheduling Algorithm

### Start Run

1. Load workflow definition.
2. Create empty `RunState`.
3. Apply initial input if provided.
4. Mark initial input as `resolved`.
5. Queue all atoms once.
6. Publish `run_started`, `input_received`, and `node_queued` events.
7. Leave the queue visible to the UI.
8. Process the queue only when the UI calls `step`, `drain`, or auto-run is enabled.

Initial fanout to all atoms is acceptable because dependencies are dynamic. Branches prune themselves through `skipped`, `waiting`, and `blocked`.

### Process Atom

1. Dequeue the next browser-managed event.
2. Load state.
3. Ignore if node is terminal.
4. Move the event from `pending` to `running`.
5. Mark node `running`.
6. Publish `node_started`.
7. Execute through the configured `Executor`.
8. Record every dependency read as an edge.
9. Store one of:
   - `resolved`
   - `skipped`
   - `waiting`
   - `blocked`
   - `errored`
10. Move the event from `running` to `completed` or `failed`.
11. Publish node result events.
12. Wake waiters whose dependencies are now terminal.
13. Save state.

### Submit Deferred Input

1. Load state.
2. Validate payload against input schema.
3. Mark input node `resolved`.
4. Find waiters for that input.
5. Queue only those waiters.
6. Publish `input_received` and `node_queued`.

## What Changes In `packages/core`

Keep changes small.

Required:

- expose dependency-read observer hook,
- expose node lifecycle observer hooks,
- support optional `AtomContext`,
- make registry construction explicit for non-global use,
- avoid forcing graph construction into the runtime.

Nice to have:

- split durable result status from scheduler execution status,
- support artifact refs for large outputs,
- make `RunState` versionable.

Do not add Cloudflare concepts to `packages/core`.

## What Changes In `apps/backend`

The backend should become optional.

Near term:

- keep `/graph` as a dev/demo endpoint if useful,
- stop treating it as the canonical execution model,
- move scheduling logic into shared `packages/runtime`.

Later:

- replace `/graph` with API routes backed by a real `Scheduler` implementation.

## Cloudflare Adapter Later

When ready, implement the same interfaces with Cloudflare:

```text
StateStore -> Run Durable Object
WorkQueue  -> Cloudflare Queue
EventSink  -> Durable Object WebSocket/SSE
WorkflowLoader -> static bundle, manifest, or Dynamic Worker
```

No workflow code should change.

No UI graph semantics should change.

Only adapters change.

### Cloudflare Mapping

```text
API Worker
  calls Scheduler methods

Run Durable Object
  implements StateStore
  owns run state, leases, subscribers

Cloudflare Queue
  implements WorkQueue
  carries atom events

Queue Consumer Worker
  calls Scheduler.processEvent(event)

DO WebSocket/SSE
  implements EventSink
```

### Additional Cloudflare Concerns

Add these only when moving off local/client execution:

- node leases,
- stale Queue message rejection,
- duplicate delivery idempotency,
- Durable Object alarms for lease expiry,
- R2 artifact storage,
- D1 run index,
- auth and authorization,
- value redaction,
- retry/backoff policy.

## Workflow Loading Policy

Avoid request-time `new Function()` in the long-term design.

Supported loading modes:

1. **Client/local dev mode**
   - current raw workflow editing can continue for iteration,
   - not a production trust boundary.

2. **Static bundle mode**
   - workflows are imported modules,
   - best first deploy target.

3. **Manifest mode**
   - build extracts inputs, atoms, descriptions, schemas,
   - UI uses manifest before execution discovers edges.

4. **Dynamic Worker mode**
   - only for runtime-authored code,
   - sandboxed and capability-limited.

## Migration Plan

### Phase 1: Introduce Interfaces

- Add `StateStore`, `WorkQueue`, `EventSink`, `WorkflowLoader`, and `Executor`.
- Add `Scheduler` using current `createRuntime()` semantics.
- Add memory/browser adapters.
- Keep existing UI but feed it from `RunSnapshot` and `RunEvent`.

### Phase 2: Move Client To Scheduler

- Start runs through local `Scheduler.startRun`.
- Submit deferred input through `Scheduler.submitInput`.
- Replace manual `/graph` advancement with browser `WorkQueue` processing.
- Add queue controls: step, drain, pause, retry, inspect.
- Keep backend optional for demos.

### Phase 3: Improve Runtime Observability

- Emit edge discovery events from `get()`.
- Emit `queued` and `running`.
- Add event replay from local event log.
- Add graph snapshot rebuilding from state.

### Phase 4: Stateless Serverless Executor

- Add `ServerlessExecutor`.
- Add `POST /execute-atom`.
- Keep `StateStore`, `WorkQueue`, and `EventSink` in the browser.
- Use backend only for atom attempts that need server capabilities.

Exit criteria:

- UI still owns the queue.
- Backend can execute one atom attempt and return a portable result.
- Browser timeline shows the serverless attempt as `running`.

### Phase 5: Server Adapter

- Add a server-side scheduler using the same interfaces.
- State can start as in-memory or SQLite/D1-like, depending on environment.
- Client switches from local scheduler to HTTP scheduler without graph model changes.

### Phase 6: Cloudflare Adapter

- Implement Run Durable Object as authoritative state.
- Implement Cloudflare Queue adapter.
- Implement WebSocket/SSE event sink.
- Add leases, retries, stale completion protection, and auth.

## Acceptance Criteria

The abstraction work is successful when:

- the same workflow can run against memory adapters and future Cloudflare adapters,
- the UI consumes snapshots/events, not backend-specific response shapes,
- the browser can own and inspect the WorkQueue,
- the backend can be used only as a stateless atom executor,
- `packages/core` has no Cloudflare dependency,
- state ownership is behind `StateStore`,
- work scheduling is behind `WorkQueue`,
- live graph updates are behind `EventSink`,
- atom execution location is behind `Executor`,
- runtime-discovered edges are preserved,
- deferred inputs work without changing workflow code,
- parallel execution is a scheduler capability, not hardcoded into atoms.

## Open Questions

- Should local/client mode auto-drain the queue, or expose manual step-through for debugging?
- Should `queued/running` be part of `NodeStatus` or separate `ExecutionStatus`?
- Should `RunState` store graph edges directly, or should graph snapshots be derived from node deps?
- Should manifests be required before Cloudflare, or introduced only when static bundles become awkward?
- What is the smallest useful `AtomContext` for local mode?
