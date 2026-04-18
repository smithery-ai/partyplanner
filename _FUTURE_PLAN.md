# Reactive Workflow Engine — Implementation Plan

## Project Summary

Build a reactive, signals-inspired workflow engine on Cloudflare's stack. Users define workflows using a Jotai/Signals-like API (`input()`, `atom()`, `get()`) in plain JavaScript. The system automatically discovers the dependency graph at runtime via call tracing, executes workflows as Cloudflare Dynamic Workers, persists state in Durable Objects for durable/resumable execution, and renders the live DAG in an embedded visual editor.

---

## Core Concepts

| Concept | Description |
|---------|-------------|
| `input(schema)` | A typed event source. Validated by Zod. Represents an external trigger (Slack message, email, webhook, etc.). |
| `input.deferred(schema)` | Same as `input()` but the runtime **waits** instead of skipping when the input hasn't arrived yet. Used for multi-step workflows that pause for human action. |
| `atom(fn)` | A derived computation. Its function receives `get` and can read from inputs or other atoms. Dependencies are discovered implicitly via `get()` calls at runtime. |
| `get(atom)` | Read and subscribe. Recursively resolves the target atom. Throws `SkipError` if an `input()` is unpopulated. Throws `WaitError` if an `input.deferred()` is unpopulated. |
| `get.maybe(atom)` | Soft read. Returns `undefined` instead of throwing when an input is unavailable. For atoms that want to handle multiple event types. |
| `get.skip(reason)` | Explicit self-skip. An atom calls this to remove itself from the current run. |

**User-facing code example:**

```js
import { input, atom } from "reactive-workflow";
import { z } from "zod";

// Inputs — typed event sources
const slack = input(z.object({ message: z.string(), channel: z.string(), user: z.string() }));
const email = input(z.object({ from: z.string(), subject: z.string(), body: z.string() }));
const approvalResponse = input.deferred(z.object({ approved: z.boolean(), approver: z.string() }));

// Atoms — reactive computations
const classify = atom(async (get) => {
  try { return await llm.classify(get(slack).message); } catch {}
  try { return await llm.classify(get(email).body); } catch {}
  return get.skip("No Slack or email message was available");
});

const draft = atom(async (get) => {
  const priority = get(classify);
  const msg = get.maybe(slack);
  const mail = get.maybe(email);
  return await llm.draft(msg?.message ?? mail?.body, { priority });
});

const sendDraft = atom(async (get) => {
  const text = get(draft);
  const approval = get(approvalResponse); // pauses here until human approves
  if (!approval.approved) return get.skip("Approval was denied");
  await sendSlackMessage("#outgoing", text);
});
```

---

## Architecture Overview

```
                    External Events
                    (Slack, Email, Webhooks, Cron)
                          │
                          ▼
              ┌───────────────────────┐
              │   Gateway Worker      │  ← Cloudflare Worker (static, deployed via wrangler)
              │   - Route events      │
              │   - Validate payloads │
              │   - Lookup workflow   │
              └──────────┬────────────┘
                         │
                         ▼
              ┌───────────────────────┐
              │   Workflow DO         │  ← Durable Object (one per workflow instance)
              │   - Stores atom defs  │
              │   - Stores run state  │
              │   - Checkpoint store  │
              │   - WebSocket host    │
              │   - Alarm scheduler   │
              └──────────┬────────────┘
                         │
                         ▼
              ┌───────────────────────┐
              │   Dynamic Worker      │  ← Cloudflare Dynamic Worker (ephemeral)
              │   - Loads atom code   │
              │   - Runs the graph    │
              │   - Reports trace     │
              └───────────────────────┘
                         │
                         ▼
              ┌───────────────────────┐
              │   Editor UI           │  ← SPA (React), served from Worker/Pages
              │   - DAG visualization │
              │   - Inline code edit  │
              │   - Run history       │
              │   - Live via WS       │
              └───────────────────────┘
```

---

## Component 1: The SDK (`reactive-workflow`)

This is a small JS library that users import when writing their workflow code. It doesn't execute anything — it just registers atoms and inputs into a manifest that the runtime reads.

### API surface

```ts
// input.ts
function input<T>(schema: ZodSchema<T>): Input<T>

// input has a .deferred variant
input.deferred = function<T>(schema: ZodSchema<T>): DeferredInput<T>

// atom.ts
function atom<T>(fn: (get: Get) => Promise<T>): Atom<T>

// get.ts (passed into atom functions at runtime)
interface Get {
  <T>(source: Input<T> | Atom<T>): Promise<T>   // throws SkipError or WaitError
  maybe<T>(source: Input<T> | Atom<T>): Promise<T | undefined>
  skip(reason?: string): never   // throws SkipError
}
```

### Internal registration

Each call to `input()` or `atom()` pushes a descriptor into a global registry:

```ts
// registry.ts
const registry = {
  inputs: Map<string, { id: string, schema: ZodSchema, deferred: boolean }>,
  atoms: Map<string, { id: string, fn: Function }>,
};
```

IDs can be auto-generated or the user can name them:

```js
const slack = input("slack", z.object({ ... }));
const classify = atom("classify", async (get) => { ... });
```

Named IDs are better for the visualization and for stable caching in `env.LOADER.get()`.

### Build output

The SDK ships with a build step (or works without one if the user's code is evaluated directly). The output is a module string that exports the registry — this is what gets passed to the Dynamic Worker as `modules["workflow.js"]`.

### Files to create

```
packages/sdk/
  src/
    input.ts
    atom.ts
    get.ts
    registry.ts
    errors.ts        ← SkipError, WaitError classes
    index.ts         ← re-exports
  package.json
  tsconfig.json
```

---

## Component 2: The Runtime

This runs **inside** the Dynamic Worker. It imports the user's workflow module, reads the registry, and executes the atom graph for a given payload.

### Core runtime class

```ts
// runtime.ts
class Runtime {
  private values: Map<string, any> = new Map();
  private skipped: Set<string> = new Set();
  private waiting: Map<string, string> = new Map();   // atomId → waitingOnInputId
  private resolving: Map<string, Promise<any>> = new Map();
  private deps: Map<string, string[]> = new Map();    // atomId → [depIds] (captured during execution)
  private timings: Map<string, number> = new Map();
  private inputs: Map<string, any> = new Map();
  private checkpoints: Map<string, any>;               // loaded from DO at start of run

  constructor(
    private registry: Registry,
    private stateBinding: StateRPC,    // env.STATE — RPC to the DO
  ) {}

  async run(eventType: string, payload: any, checkpoints: Map<string, any>): Promise<RunTrace> {
    this.reset();
    this.checkpoints = checkpoints;

    // Validate payload against the matching input's Zod schema
    const inputDef = this.registry.inputs.get(eventType);
    if (!inputDef) throw new Error(`Unknown input: ${eventType}`);
    const validated = inputDef.schema.parse(payload);
    this.inputs.set(eventType, validated);

    // Resolve all terminal atoms (atoms that no other atom depends on).
    // Terminal detection: after one tracing pass, any atom not referenced
    // by another atom's deps set is terminal.
    // For first run: try resolving ALL atoms, let SkipError prune the graph.
    const allAtomIds = [...this.registry.atoms.keys()];
    await Promise.allSettled(
      allAtomIds.map(id => this.resolve(id).catch(e => {
        if (e instanceof SkipError || e instanceof WaitError) return;
        throw e;
      }))
    );

    return this.buildTrace();
  }

  private async resolve(atomId: string): Promise<any> {
    // 1. Already computed this run
    if (this.values.has(atomId)) return this.values.get(atomId);

    // 2. Already skipped/waiting this run
    if (this.skipped.has(atomId)) throw new SkipError(atomId);
    if (this.waiting.has(atomId)) throw new WaitError(this.waiting.get(atomId)!);

    // 3. Already in-flight (dedup)
    if (this.resolving.has(atomId)) return this.resolving.get(atomId);

    // 4. Check if it's an input
    const inputDef = this.registry.inputs.get(atomId);
    if (inputDef) {
      if (this.inputs.has(atomId)) return this.inputs.get(atomId);
      // Not populated this run — check if deferred
      if (inputDef.deferred) {
        this.waiting.set(atomId, atomId);
        throw new WaitError(atomId);
      }
      this.skipped.add(atomId);
      throw new SkipError(atomId);
    }

    // 5. Check DO checkpoint from a previous run
    if (this.checkpoints.has(atomId)) {
      const val = this.checkpoints.get(atomId);
      this.values.set(atomId, val);
      return val;
    }

    // 6. Derived atom — execute its function
    const atomDef = this.registry.atoms.get(atomId);
    if (!atomDef) throw new Error(`Unknown atom: ${atomId}`);

    const start = performance.now();
    const depsForThisAtom: string[] = [];

    const get = async (target: { id: string }) => {
      depsForThisAtom.push(target.id);
      return this.resolve(target.id);
    };
    get.maybe = async (target: { id: string }) => {
      depsForThisAtom.push(target.id);
      try { return await this.resolve(target.id); }
      catch (e) {
        if (e instanceof SkipError || e instanceof WaitError) return undefined;
        throw e;
      }
    };
    get.skip = () => { throw new SkipError(atomId); };

    const promise = atomDef.fn(get);
    this.resolving.set(atomId, promise);

    try {
      const result = await promise;
      this.values.set(atomId, result);
      this.deps.set(atomId, depsForThisAtom);
      this.timings.set(atomId, performance.now() - start);
      return result;
    } catch (e) {
      if (e instanceof SkipError) this.skipped.add(atomId);
      if (e instanceof WaitError) this.waiting.set(atomId, (e as WaitError).inputId);
      this.deps.set(atomId, depsForThisAtom);
      this.timings.set(atomId, performance.now() - start);
      throw e;
    } finally {
      this.resolving.delete(atomId);
    }
  }

  private buildTrace(): RunTrace {
    return {
      atoms: Object.fromEntries(
        [...this.registry.atoms.keys(), ...this.registry.inputs.keys()].map(id => [id, {
          status: this.values.has(id) ? "resolved"
                : this.skipped.has(id) ? "skipped"
                : this.waiting.has(id) ? "waiting"
                : "not_reached",
          value: this.values.get(id),
          deps: this.deps.get(id) ?? [],
          duration_ms: this.timings.get(id) ?? 0,
          waitingOn: this.waiting.get(id),
        }])
      ),
    };
  }
}
```

### Dynamic Worker entry point

This is the `mainModule` passed to `env.LOADER.get()`:

```js
// runtime-entry.js (template — atom code is injected as a separate module)
import { registry } from "./workflow.js";
import { Runtime } from "./runtime.js";

export default {
  async fetch(request, env) {
    const { eventType, payload, checkpoints } = await request.json();

    const runtime = new Runtime(registry, env.STATE);
    const trace = await runtime.run(eventType, payload, new Map(Object.entries(checkpoints)));

    return Response.json(trace);
  }
};
```

### Files to create

```
packages/runtime/
  src/
    runtime.ts
    runtime-entry.ts
    errors.ts
```

---

## Component 3: Gateway Worker

A statically deployed Cloudflare Worker. Receives all external events, routes them to the right Workflow DO, which then spins up Dynamic Workers.

### Responsibilities

1. Receive webhooks (Slack, GitHub, email via Cloudflare Email Workers, generic HTTP)
2. Normalize the event into `{ workflowId, eventType, payload }`
3. Forward to the correct Workflow DO
4. Serve the editor UI (SPA static assets)
5. Handle auth (Cloudflare Access or custom)

### Routing

```ts
// gateway.ts
export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    // Webhook ingress: POST /webhook/:workflowId/:eventType
    if (url.pathname.startsWith("/webhook/")) {
      const [, , workflowId, eventType] = url.pathname.split("/");
      const payload = await request.json();

      const doId = env.WORKFLOW_DO.idFromName(workflowId);
      const stub = env.WORKFLOW_DO.get(doId);
      const result = await stub.handleEvent(eventType, payload);

      return Response.json(result);
    }

    // Editor API: GET/PUT /api/workflows/:id/...
    if (url.pathname.startsWith("/api/")) {
      return handleAPI(request, env);
    }

    // Editor UI: serve static assets
    return env.ASSETS.fetch(request);
  },

  // Cloudflare Queue consumer — alternative to webhooks
  async queue(batch: MessageBatch, env: Env) {
    for (const msg of batch.messages) {
      const { workflowId, eventType, payload } = msg.body;
      const doId = env.WORKFLOW_DO.idFromName(workflowId);
      const stub = env.WORKFLOW_DO.get(doId);
      await stub.handleEvent(eventType, payload);
      msg.ack();
    }
  }
};
```

### Wrangler config

```toml
name = "reactive-workflow-gateway"
main = "src/gateway.ts"
compatibility_date = "2025-03-24"

[durable_objects]
bindings = [
  { name = "WORKFLOW_DO", class_name = "WorkflowDO" }
]

[[migrations]]
tag = "v1"
new_classes = ["WorkflowDO"]

[vars]
ENVIRONMENT = "production"

# Dynamic Worker loader
[[unsafe.bindings]]
name = "LOADER"
type = "dynamic-worker-loader"
```

### Files to create

```
apps/gateway/
  src/
    gateway.ts
    api.ts            ← REST API for editor CRUD
    webhooks.ts       ← normalize incoming webhooks per source
  wrangler.toml
```

---

## Component 4: Workflow Durable Object

One DO instance per workflow. This is the brain — it stores workflow definitions, manages execution, checkpoints state, and hosts WebSocket connections for the live editor.

### Storage schema

Use DO's transactional key-value storage with a key prefix convention:

| Key pattern | Value | Purpose |
|-------------|-------|---------|
| `meta` | `{ id, name, createdAt, version }` | Workflow metadata |
| `atoms` | `{ [atomId]: { code: string, type: "input" \| "atom" \| "deferred_input", schema?: string } }` | Full atom/input definitions |
| `checkpoint:{atomId}` | `{ value: any, runId: string, resolvedAt: number }` | Latest resolved value per atom (for durable resume) |
| `run:{runId}` | `RunTrace` (see below) | Historical run data |
| `run-index` | `string[]` | List of runIds, newest first, capped at N |
| `pending` | `{ [inputId]: { waitingSince: number, waitingAtoms: string[] } }` | Which deferred inputs the workflow is blocked on |

### RunTrace type

```ts
type RunTrace = {
  id: string;
  workflowId: string;
  trigger: string;               // which input fired
  payload: any;
  startedAt: number;
  completedAt: number;
  atoms: {
    [atomId: string]: {
      status: "resolved" | "skipped" | "waiting" | "errored";
      value?: any;
      error?: string;
      deps: string[];             // which atoms this one called get() on
      duration_ms: number;
      waitingOn?: string;         // for "waiting" status, which input
    }
  };
};
```

### Core DO class

```ts
export class WorkflowDO extends DurableObject {
  private sessions: Set<WebSocket> = new Set();

  // ── Event handling ────────────────────────────────

  async handleEvent(eventType: string, payload: any): Promise<RunTrace> {
    const atoms = await this.ctx.storage.get("atoms");
    const pending = await this.ctx.storage.get("pending") ?? {};

    // Load checkpoints for all previously resolved atoms
    const checkpointKeys = Object.keys(atoms)
      .map(id => `checkpoint:${id}`);
    const checkpoints = await this.ctx.storage.get(checkpointKeys);

    const checkpointMap: Record<string, any> = {};
    for (const [key, val] of checkpoints) {
      const atomId = key.replace("checkpoint:", "");
      checkpointMap[atomId] = val.value;
    }

    // Build the Dynamic Worker code
    const workerCode = this.buildWorkerCode(atoms);
    const version = await this.getVersion();

    // Spin up Dynamic Worker
    const worker = this.env.LOADER.get(
      `${this.workflowId}:${version}`,
      () => ({
        compatibilityDate: "2025-03-24",
        mainModule: "entry.js",
        modules: workerCode,
        env: {
          STATE: this.ctx.exports.StateBinding({
            props: { workflowId: this.workflowId }
          }),
        },
      })
    );

    // Execute
    const response = await worker.fetch("http://internal/run", {
      method: "POST",
      body: JSON.stringify({ eventType, payload, checkpoints: checkpointMap }),
    });

    const trace: RunTrace = await response.json();

    // Persist results
    await this.persistRun(trace);
    await this.updateCheckpoints(trace);
    await this.updatePending(trace);
    await this.scheduleAlarms(trace);

    // Broadcast to connected editors
    this.broadcast({ type: "run_completed", trace });

    return trace;
  }

  // ── Checkpoint persistence ────────────────────────

  private async persistRun(trace: RunTrace) {
    await this.ctx.storage.put(`run:${trace.id}`, trace);

    const index = (await this.ctx.storage.get("run-index")) ?? [];
    index.unshift(trace.id);
    if (index.length > 100) index.length = 100;  // cap history
    await this.ctx.storage.put("run-index", index);
  }

  private async updateCheckpoints(trace: RunTrace) {
    const puts: Record<string, any> = {};
    for (const [atomId, info] of Object.entries(trace.atoms)) {
      if (info.status === "resolved") {
        puts[`checkpoint:${atomId}`] = {
          value: info.value,
          runId: trace.id,
          resolvedAt: Date.now(),
        };
      }
    }
    if (Object.keys(puts).length > 0) {
      await this.ctx.storage.put(puts);  // batch write
    }
  }

  private async updatePending(trace: RunTrace) {
    const pending: Record<string, any> = {};
    for (const [atomId, info] of Object.entries(trace.atoms)) {
      if (info.status === "waiting" && info.waitingOn) {
        if (!pending[info.waitingOn]) {
          pending[info.waitingOn] = { waitingSince: Date.now(), waitingAtoms: [] };
        }
        pending[info.waitingOn].waitingAtoms.push(atomId);
      }
    }
    await this.ctx.storage.put("pending", pending);
  }

  // ── Alarms (timeouts for deferred inputs) ─────────

  private async scheduleAlarms(trace: RunTrace) {
    const pending = await this.ctx.storage.get("pending") ?? {};
    if (Object.keys(pending).length > 0) {
      // Check again in 1 hour. The alarm handler can escalate or timeout.
      await this.ctx.storage.setAlarm(Date.now() + 3600_000);
    }
  }

  async alarm() {
    const pending = await this.ctx.storage.get("pending") ?? {};
    for (const [inputId, info] of Object.entries(pending)) {
      const elapsed = Date.now() - info.waitingSince;
      if (elapsed > 48 * 3600_000) {  // 48-hour timeout, configurable
        // Fire a timeout event — could trigger a special atom
        await this.handleEvent("__timeout", { inputId, elapsed });
      }
    }
    // Re-schedule if still pending
    if (Object.keys(pending).length > 0) {
      await this.ctx.storage.setAlarm(Date.now() + 3600_000);
    }
  }

  // ── WebSocket for live editor ─────────────────────

  async fetch(request: Request) {
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      this.sessions.add(pair[1]);

      // Send current state on connect
      const atoms = await this.ctx.storage.get("atoms");
      const pending = await this.ctx.storage.get("pending");
      const checkpoints = await this.ctx.storage.get(
        Object.keys(atoms).map(id => `checkpoint:${id}`)
      );
      pair[1].send(JSON.stringify({
        type: "init",
        atoms,
        checkpoints: Object.fromEntries(checkpoints),
        pending,
      }));

      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    // Handle REST calls from editor (save atoms, get run history, etc.)
    return this.handleREST(request);
  }

  webSocketClose(ws: WebSocket) {
    this.sessions.delete(ws);
  }

  webSocketMessage(ws: WebSocket, message: string) {
    const msg = JSON.parse(message);
    // Handle editor commands: save atom, trigger test run, etc.
  }

  private broadcast(data: any) {
    const payload = JSON.stringify(data);
    for (const ws of this.sessions) {
      ws.send(payload);
    }
  }

  // ── Dynamic Worker code builder ───────────────────

  private buildWorkerCode(atoms: Record<string, AtomDef>): Record<string, string> {
    // Generates the module code that the Dynamic Worker will execute.
    // Combines the runtime with the user's atom definitions.

    const workflowModule = this.generateWorkflowModule(atoms);

    return {
      "entry.js": RUNTIME_ENTRY_CODE,    // static, the runtime-entry.ts compiled
      "runtime.js": RUNTIME_CODE,         // static, the runtime.ts compiled
      "workflow.js": workflowModule,      // dynamic, user's atoms
    };
  }

  private generateWorkflowModule(atoms: Record<string, AtomDef>): string {
    // Emits JS code that registers all atoms and inputs
    let code = `import { input, atom, registry } from "./runtime.js";\n\n`;

    for (const [id, def] of Object.entries(atoms)) {
      if (def.type === "input") {
        code += `const ${id} = input("${id}", ${def.schema});\n`;
      } else if (def.type === "deferred_input") {
        code += `const ${id} = input.deferred("${id}", ${def.schema});\n`;
      } else {
        code += `const ${id} = atom("${id}", ${def.code});\n`;
      }
    }

    code += `\nexport { registry };\n`;
    return code;
  }
}
```

### Files to create

```
apps/gateway/
  src/
    workflow-do.ts
    state-binding.ts     ← WorkerEntrypoint for env.STATE RPC
    code-builder.ts      ← generates workflow.js from atom definitions
```

---

## Component 5: Editor UI

A React SPA served by the Gateway Worker (or Cloudflare Pages). Connects to the Workflow DO via WebSocket for real-time updates.

### Views

**1. Workflow List Page**
- Cards for each workflow showing name, status (active/has pending inputs), last run time.
- "Create Workflow" button.

**2. Workflow Editor (main view) — three panels:**

```
┌──────────────────────────────────────────────────────────────┐
│  Toolbar:  [Run name]  [▶ Test Run]  [Deploy]  [History ▾]  │
├──────────────────┬───────────────────────────────────────────┤
│                  │                                           │
│   Code Panel     │         DAG Canvas                        │
│                  │                                           │
│   - Full workflow│   - Nodes = atoms/inputs                  │
│     source code  │   - Edges = get() dependencies            │
│   - Monaco editor│   - Color = status per run                │
│   - Syntax for   │   - Click node = highlight in code        │
│     input/atom   │   - Hover edge = show value               │
│                  │                                           │
│                  │                                           │
├──────────────────┴───────────────────────────────────────────┤
│  Run Inspector (collapsible bottom panel)                    │
│  - Timeline of runs                                         │
│  - Selected run: atom statuses, values, durations            │
│  - Errors with stack traces                                  │
│  - "Retry" button on errored atoms                           │
└──────────────────────────────────────────────────────────────┘
```

### DAG Layout

Use Dagre (or ELK.js) for automatic graph layout. Left-to-right orientation.

**Node types and visual treatment:**

| Type | Shape | Default color | Active run colors |
|------|-------|---------------|-------------------|
| `input()` | Rounded rectangle with antenna/bolt icon | Blue border | Blue (populated), Grey (not this run) |
| `input.deferred()` | Same + clock icon | Amber border | Amber pulsing (waiting), Green (arrived) |
| `atom()` | Rounded rectangle | Grey border | Green (resolved), Grey (skipped), Red (errored) |

**Edge rendering:**
- Solid line = dependency was resolved this run
- Dashed line = dependency exists in graph but was skipped this run
- Edge label on hover = the serialized value that flowed along it
- Animate edges during live execution (pulse from source to target)

### Code ↔ Canvas sync

- Clicking a node in the DAG highlights the corresponding `atom()` or `input()` call in the code panel (and vice versa).
- Editing code and saving re-parses the atom definitions, sends them to the DO, the DO bumps the version, and the DAG re-renders. This is the hot-reload path.
- Optionally: right-click canvas → "Add atom" scaffolds a new `atom("name", async (get) => { })` in the code.

### WebSocket protocol

Messages from server (DO) to client:

```ts
{ type: "init", atoms, checkpoints, pending }
{ type: "run_completed", trace: RunTrace }
{ type: "run_started", runId, trigger, payload }
{ type: "atom_resolved", runId, atomId, value, duration_ms }  // real-time per-atom updates
{ type: "atom_errored", runId, atomId, error }
{ type: "atoms_updated", atoms }   // another editor changed the code
```

Messages from client to server:

```ts
{ type: "save_atoms", atoms }
{ type: "trigger_test_run", eventType, payload }
{ type: "retry_atom", runId, atomId }
{ type: "get_run", runId }
{ type: "get_run_history", limit, offset }
```

### Technology choices

- **React** with TypeScript
- **ReactFlow** (https://reactflow.dev) for the DAG canvas — it handles node/edge rendering, layout, zoom/pan, and interactions out of the box
- **Monaco Editor** for the code panel (same engine as VS Code)
- **Tailwind CSS** for styling
- **Zustand** for client state management (ironic but appropriate)

### Files to create

```
apps/editor/
  src/
    App.tsx
    components/
      DAGCanvas.tsx          ← ReactFlow-based DAG renderer
      CodePanel.tsx           ← Monaco editor wrapper
      RunInspector.tsx        ← bottom panel, run timeline + details
      AtomNode.tsx            ← custom ReactFlow node component
      InputNode.tsx           ← custom ReactFlow node for inputs
      Toolbar.tsx
    hooks/
      useWorkflowSocket.ts   ← WebSocket connection + state sync
      useDAGLayout.ts         ← Dagre layout computation from atom registry
      useRunOverlay.ts        ← overlays run status onto DAG nodes
    lib/
      parseWorkflow.ts        ← parse code string → atom/input definitions
      traceToDAG.ts           ← convert RunTrace → ReactFlow nodes/edges
    types.ts
  package.json
  tsconfig.json
  vite.config.ts
```

---

## Component 6: Durable Workflow Execution (detailed flow)

### Scenario: Multi-step approval workflow

```js
const ticket = input("ticket", z.object({ title: z.string(), amount: z.number() }));
const approval = input.deferred("approval", z.object({ approved: z.boolean() }));

const review = atom("review", async (get) => {
  const t = get(ticket);
  return await llm.assess(t);
});

const process = atom("process", async (get) => {
  const assessment = get(review);
  const decision = get(approval);  // blocks until human approves
  if (!decision.approved) return get.skip("Approval was denied");
  await submitExpense(get(ticket), assessment);
});
```

### Run 1 — Ticket submitted

```
1. Gateway receives POST /webhook/expense-flow/ticket
   Body: { title: "Conference travel", amount: 2500 }

2. Gateway calls WorkflowDO.handleEvent("ticket", payload)

3. DO loads atom definitions, finds no existing checkpoints (first run)

4. DO spins up Dynamic Worker:
   env.LOADER.get("expense-flow:v1", () => ({ ... }))

5. Dynamic Worker executes:
   - resolve("review")
     - get(ticket) → payload ✓
     - llm.assess() → { risk: "low", recommendation: "approve" }
     - status: resolved ✓
   - resolve("process")
     - get(review) → resolved ✓
     - get(approval) → WaitError! (deferred input, not yet populated)
     - status: waiting, waitingOn: "approval"

6. RunTrace returned to DO:
   {
     atoms: {
       ticket: { status: "resolved", value: { title: "...", amount: 2500 } },
       review: { status: "resolved", value: { risk: "low", ... } },
       approval: { status: "waiting" },
       process: { status: "waiting", waitingOn: "approval" }
     }
   }

7. DO persists:
   - checkpoint:ticket = payload
   - checkpoint:review = { risk: "low", ... }
   - pending = { approval: { waitingSince: now, waitingAtoms: ["process"] } }
   - run:abc123 = full trace
   - Sets alarm for timeout check

8. DO broadcasts to editor WebSocket:
   - DAG shows: ticket ✅ → review ✅ → process ⏳ (waiting for approval)
   - approval node pulses amber
```

### Run 2 — Manager approves (hours/days later)

```
1. Gateway receives POST /webhook/expense-flow/approval
   Body: { approved: true }

2. DO loads checkpoints:
   - checkpoint:ticket = { title: "...", amount: 2500 }
   - checkpoint:review = { risk: "low", ... }

3. DO spins up Dynamic Worker with checkpoints

4. Dynamic Worker executes:
   - resolve("review")
     - checkpoint exists → returns cached value, does NOT re-run llm.assess()
   - resolve("process")
     - get(review) → from checkpoint ✓
     - get(approval) → populated this run ✓
     - submitExpense() runs ✓
     - status: resolved ✓

5. DO persists:
   - checkpoint:process = result
   - pending = {} (nothing waiting anymore)
   - Cancels alarm

6. Editor DAG: all nodes green ✅
```

### Error handling and retries

If an atom throws a real error (not Skip/Wait):

```
1. The trace records: { status: "errored", error: "API timeout" }
2. DO does NOT checkpoint the errored atom
3. DO broadcasts error to editor
4. Editor shows red node with error message
5. User clicks "Retry" → DO re-runs with existing checkpoints
6. Only the errored atom (and its dependents) re-execute;
   previously resolved atoms load from checkpoint
```

---

## Implementation Phases

### Phase 1: Core Runtime (week 1-2)

**Goal:** Atoms execute in a Dynamic Worker, payloads route correctly, traces are returned.

- [ ] Set up monorepo (Turborepo or npm workspaces)
- [ ] Implement SDK: `input()`, `atom()`, `get()`, `get.maybe()`, `get.skip(reason)`
- [ ] Implement `SkipError` and `WaitError`
- [ ] Implement Runtime class with `resolve()` and `run()`
- [ ] Build Dynamic Worker entry point
- [ ] Deploy Gateway Worker with hardcoded test workflow
- [ ] Verify: send test payloads via curl, get back correct traces
- [ ] Test: multi-input workflows, conditional get(), skip propagation

### Phase 2: Durable Object + Persistence (week 3-4)

**Goal:** Workflows persist state across runs, durable workflows work.

- [ ] Implement WorkflowDO class
- [ ] Storage: atom definitions, checkpoints, run history
- [ ] Checkpoint loading into Dynamic Worker
- [ ] Durable workflow: WaitError → pending state → resume on next input
- [ ] Alarms for timeout on deferred inputs
- [ ] REST API for CRUD on workflows
- [ ] Test: multi-step workflow (submit → wait → approve → complete)
- [ ] Test: error + retry flow

### Phase 3: Editor UI — DAG Visualization (week 5-6)

**Goal:** Users can see their workflow as a DAG with run overlays.

- [ ] React app scaffolding with Vite
- [ ] ReactFlow integration with custom node components
- [ ] Dagre layout from atom definitions
- [ ] WebSocket connection to DO
- [ ] Live run overlay (node colors, edge values)
- [ ] Run history sidebar
- [ ] Run inspector panel (click a run, see atom details)

### Phase 4: Editor UI — Code Editing (week 7-8)

**Goal:** Users can edit workflow code in the browser and see changes live.

- [ ] Monaco editor integration
- [ ] Parse workflow code → atom definitions (simple AST or regex-based)
- [ ] Save atoms to DO, version bump, DAG re-render
- [ ] Code ↔ DAG click sync (click node → highlight code, click code → highlight node)
- [ ] Test run from editor (input a test payload, watch DAG execute live)
- [ ] Error display in editor (red squiggles, inline error messages)

### Phase 5: Production Hardening (week 9-10)

**Goal:** Ready for real usage.

- [ ] Auth (Cloudflare Access or custom JWT)
- [ ] Webhook signature verification (Slack, GitHub, etc.)
- [ ] Rate limiting on event ingress
- [ ] Input validation error reporting (Zod errors surfaced to editor)
- [ ] Run log retention policy (auto-prune old runs)
- [ ] Observability: Tail Workers on Dynamic Workers for structured logging
- [ ] Error alerting (integrate with PagerDuty/Slack for errored atoms)
- [ ] Deployment pipeline (wrangler deploy for gateway, Pages for editor)

---

## Open Design Decisions

These should be resolved during implementation. Documenting them here so they don't get lost.

**1. Atom ID assignment.** Auto-generated IDs (UUIDs) are stable but meaningless. Named IDs (`atom("classify", ...)`) are readable but require uniqueness enforcement. Recommendation: require named IDs. They appear in the DAG, in logs, in checkpoint keys — readability matters.

**2. Serialization of atom values.** Values flow between runs via DO storage. They must be JSON-serializable. Should the runtime enforce this (throw if an atom returns a non-serializable value) or silently drop non-serializable fields? Recommendation: enforce and throw — silent data loss is worse than a clear error.

**3. Exactly-once semantics.** The checkpoint model gives at-most-once for resolved atoms (they don't re-run). But if the Dynamic Worker crashes after executing a side effect but before returning the trace, the DO won't have the checkpoint and will re-run the atom. For true exactly-once, atoms with side effects would need to be idempotent, or use the DO's transactional storage to record completion before executing the side effect. Flag this as a known limitation for v1 and document that side-effectful atoms should be idempotent.

**4. Graph versioning and migration.** When a user edits an atom's code, in-flight durable workflows have checkpoints from the old code. Should old checkpoints be invalidated? Carry forward? This needs a migration strategy. Simplest v1 approach: changing any atom code starts a new "version," and in-flight workflows continue on the old version. New events start on the new version.

**5. Maximum graph size.** Dynamic Workers have CPU time limits. A workflow with hundreds of atoms making external API calls could hit the limit. Consider: should the runtime support yielding mid-graph (checkpoint after each atom, continue in a new Dynamic Worker invocation)? This adds complexity but removes the ceiling. Defer to v2.

**6. Shared atoms across workflows.** Users will want to reuse atoms (e.g., a common `classify` atom). This could be a library/import system or a "shared atoms" registry. Defer to v2.

**7. Testing/dry-run mode.** The editor's "Test Run" should probably not execute real side effects (don't actually send Slack messages). Options: mock bindings, a `dryRun` flag that atoms check, or a separate set of test bindings. Needs design.

---

## Tech Stack Summary

| Component | Technology |
|-----------|------------|
| Gateway Worker | Cloudflare Workers (TypeScript) |
| Workflow State | Cloudflare Durable Objects |
| Execution Engine | Cloudflare Dynamic Workers |
| Event Ingress | Cloudflare Queues + HTTP webhooks |
| Timeout Scheduling | DO Alarms |
| Editor Frontend | React + TypeScript + Vite |
| DAG Rendering | ReactFlow |
| Code Editor | Monaco Editor |
| Client State | Zustand |
| Styling | Tailwind CSS |
| Schema Validation | Zod |
| Hosting (Editor) | Cloudflare Pages (or Workers Sites) |
| Auth | Cloudflare Access |
| Observability | Tail Workers + DO logs |
| Monorepo | Turborepo or npm workspaces |
