import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import {
  globalRegistry,
  isHandle,
  NotReadyError,
  SkipError,
  WaitError,
} from "@rxwf/core";
import type {
  AtomDef,
  Get,
  Handle,
  NodeRecord,
  NodeStatus,
  RunState,
} from "@rxwf/core";
import { BackendRunManager, JsonStateManager } from "./run-manager";
import { evaluateWorkflowSource } from "./workflow-source";

type GraphPhase =
  | "resolved_previously"
  | "resolved_in_this_run"
  | "skipped_previously"
  | "skipped_in_this_run"
  | "waiting_previously"
  | "waiting_in_this_run"
  | "blocked_previously"
  | "blocked_in_this_run"
  | "errored_previously"
  | "errored_in_this_run"
  | "not_reached"
  | "skipped";

export type GraphRequest = {
  workflowSource: string;
  state?: RunState;
  nodeOutputs?: Record<string, unknown>;
  inputs?: Record<string, unknown>;
  stepIds?: string[];
};

export type GraphNode = {
  id: string;
  kind: "input" | "deferred_input" | "atom";
  description?: string;
  status: NodeStatus;
  phase: GraphPhase;
  label: string;
  value?: unknown;
  deps: string[];
  blockedOn?: string;
  waitingOn?: string;
  skipReason?: string;
  attempts: number;
};

export type GraphEdge = {
  id: string;
  source: string;
  target: string;
};

export type GraphResponse = {
  runId: string;
  evaluatedStepIds: string[];
  graph: {
    nodes: GraphNode[];
    edges: GraphEdge[];
  };
  state: RunState;
};

const NodeStatusSchema = z.enum([
  "resolved",
  "skipped",
  "waiting",
  "blocked",
  "errored",
  "not_reached",
]);

const GraphPhaseSchema = z.enum([
  "resolved_previously",
  "resolved_in_this_run",
  "skipped_previously",
  "skipped_in_this_run",
  "waiting_previously",
  "waiting_in_this_run",
  "blocked_previously",
  "blocked_in_this_run",
  "errored_previously",
  "errored_in_this_run",
  "not_reached",
  "skipped",
]);

const NodeRecordSchema = z
  .object({
    status: NodeStatusSchema,
    value: z.any().optional(),
    error: z
      .object({
        message: z.string(),
        stack: z.string().optional(),
      })
      .optional(),
    deps: z.array(z.string()),
    duration_ms: z.number(),
    blockedOn: z.string().optional(),
    waitingOn: z.string().optional(),
    skipReason: z.string().optional(),
    attempts: z.number(),
  })
  .openapi("NodeRecord");

const RunStateSchema = z
  .object({
    runId: z.string(),
    startedAt: z.number(),
    trigger: z.string().optional(),
    payload: z.any().optional(),
    inputs: z.record(z.any()),
    nodes: z.record(NodeRecordSchema),
    waiters: z.record(z.array(z.string())),
    processedEventIds: z.record(z.literal(true)),
  })
  .openapi("RunState");

const GraphRequestSchema = z
  .object({
    workflowSource: z.string(),
    state: RunStateSchema.optional(),
    nodeOutputs: z.record(z.any()).optional(),
    inputs: z.record(z.any()).optional(),
    stepIds: z.array(z.string()).optional(),
  })
  .openapi("GraphRequest");

const GraphNodeSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["input", "deferred_input", "atom"]),
    description: z.string().optional(),
    status: NodeStatusSchema,
    phase: GraphPhaseSchema,
    label: z.string(),
    value: z.any().optional(),
    deps: z.array(z.string()),
    blockedOn: z.string().optional(),
    waitingOn: z.string().optional(),
    skipReason: z.string().optional(),
    attempts: z.number(),
  })
  .openapi("GraphNode");

const GraphEdgeSchema = z
  .object({
    id: z.string(),
    source: z.string(),
    target: z.string(),
  })
  .openapi("GraphEdge");

const GraphResponseSchema = z
  .object({
    runId: z.string(),
    evaluatedStepIds: z.array(z.string()),
    graph: z.object({
      nodes: z.array(GraphNodeSchema),
      edges: z.array(GraphEdgeSchema),
    }),
    state: RunStateSchema,
  })
  .openapi("GraphResponse");

const ErrorSchema = z
  .object({
    message: z.string(),
  })
  .openapi("Error");

const graphRoute = createRoute({
  method: "post",
  path: "/graph",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: GraphRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: GraphResponseSchema,
        },
      },
      description: "Graph-ready shallow workflow resolution result.",
    },
    400: {
      content: {
        "application/json": {
          schema: ErrorSchema,
        },
      },
      description: "Invalid request or workflow source.",
    },
  },
});

let graphQueue = Promise.resolve();

const stateManager = new JsonStateManager();
const runManager = new BackendRunManager(stateManager);

export function createApp() {
  const app = new OpenAPIHono();

  app.use(
    "/*",
    cors({
      origin: "*",
      allowHeaders: ["Content-Type"],
      allowMethods: ["GET", "POST", "OPTIONS"],
    }),
  );
  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/runs", async (c) => {
    try {
      const body = await c.req.json();
      const response = await runManager.startRun(body);
      return c.json(response, 200);
    } catch (e) {
      const err = e as Error;
      return c.json({ message: err.message }, 400);
    }
  });

  app.post("/runs/:runId/inputs", async (c) => {
    try {
      const body = await c.req.json();
      const response = await runManager.submitInput(c.req.param("runId"), body);
      return c.json(response, 200);
    } catch (e) {
      const err = e as Error;
      return c.json({ message: err.message }, 400);
    }
  });

  app.post("/runs/:runId/advance", async (c) => {
    try {
      const response = await runManager.advanceRun(c.req.param("runId"));
      return c.json(response, 200);
    } catch (e) {
      const err = e as Error;
      return c.json({ message: err.message }, 400);
    }
  });

  app.post("/runs/:runId/auto-advance", async (c) => {
    try {
      const body = await c.req.json();
      const response = await runManager.setAutoAdvance(c.req.param("runId"), body);
      return c.json(response, 200);
    } catch (e) {
      const err = e as Error;
      return c.json({ message: err.message }, 400);
    }
  });

  app.get("/state/:runId", (c) => {
    const document = runManager.getState(c.req.param("runId"));
    if (!document) return c.json({ message: "Unknown run" }, 404);
    return c.json(document, 200);
  });

  const routes = app.openapi(graphRoute, async (c) => {
    try {
      const body = c.req.valid("json") as GraphRequest;
      const response = await enqueueGraphResolution(() => resolveGraph(body));
      return c.json(response, 200);
    } catch (e) {
      const err = e as Error;
      return c.json({ message: err.message }, 400);
    }
  });

  routes.doc("/doc", {
    openapi: "3.0.0",
    info: {
      title: "Hylo Backend",
      version: "0.0.0",
    },
  });

  return routes;
}

export type AppType = ReturnType<typeof createApp>;

async function enqueueGraphResolution<T>(work: () => Promise<T>): Promise<T> {
  const next = graphQueue.then(work, work);
  graphQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function resolveGraph(body: GraphRequest): Promise<GraphResponse> {
  evaluateWorkflowSource(body.workflowSource);

  const previousState = normalizeState(body.state);
  mergeNodeOutputs(previousState, body.nodeOutputs);

  const state = structuredClone(previousState);
  const touched = new Set<string>();
  const newInputIds = applyInputs(state, body.inputs ?? {}, touched);
  const readState = structuredClone(state);
  const evaluatedStepIds = await runImmediateAtoms(
    state,
    readState,
    previousState,
    body.stepIds,
    newInputIds,
    touched,
  );

  return {
    runId: state.runId,
    evaluatedStepIds,
    graph: {
      nodes: buildGraphNodes(state, touched),
      edges: buildGraphEdges(state),
    },
    state,
  };
}

function normalizeState(state: RunState | undefined): RunState {
  return structuredClone(
    state ?? {
      runId: `graph-run-${crypto.randomUUID()}`,
      startedAt: Date.now(),
      inputs: {},
      nodes: {},
      waiters: {},
      processedEventIds: {},
    },
  );
}

function mergeNodeOutputs(state: RunState, nodeOutputs: Record<string, unknown> | undefined): void {
  if (!nodeOutputs) return;
  for (const [id, value] of Object.entries(nodeOutputs)) {
    if (state.nodes[id]) continue;
    state.nodes[id] = {
      status: "resolved",
      value,
      deps: [],
      duration_ms: 0,
      attempts: 1,
    };
  }
}

function applyInputs(
  state: RunState,
  inputsById: Record<string, unknown>,
  touched: Set<string>,
): Set<string> {
  const applied = new Set<string>();

  for (const [inputId, payload] of Object.entries(inputsById)) {
    const def = globalRegistry.getInput(inputId);
    if (!def) throw new Error(`Unknown input: ${inputId}`);

    const validated = def.schema.parse(payload);
    state.trigger ??= inputId;
    state.payload ??= validated;
    state.inputs[inputId] = validated;
    state.nodes[inputId] = {
      status: "resolved",
      value: validated,
      deps: [],
      duration_ms: 0,
      attempts: (state.nodes[inputId]?.attempts ?? 0) + 1,
    };
    delete state.waiters[inputId];
    touched.add(inputId);
    applied.add(inputId);
  }

  return applied;
}

async function runImmediateAtoms(
  state: RunState,
  readState: RunState,
  previousState: RunState,
  stepIds: string[] | undefined,
  newInputIds: Set<string>,
  touched: Set<string>,
): Promise<string[]> {
  const ids = stepIds ?? immediateStepIds(previousState, newInputIds);
  const evaluated: string[] = [];

  for (const stepId of ids) {
    const def = globalRegistry.getAtom(stepId);
    if (!def) throw new Error(`Unknown atom: ${stepId}`);

    const prev = previousState.nodes[stepId];
    if (prev?.status === "resolved" || prev?.status === "skipped" || prev?.status === "errored") {
      continue;
    }

    await runAtomShallow(def, state, readState, touched);
    evaluated.push(stepId);
  }

  return evaluated;
}

function immediateStepIds(previousState: RunState, newInputIds: Set<string>): string[] {
  const targeted = new Set<string>();
  for (const inputId of newInputIds) {
    for (const stepId of previousState.waiters[inputId] ?? []) {
      targeted.add(stepId);
    }
  }

  if (targeted.size > 0) return [...targeted];
  return globalRegistry.allAtoms().map((def) => def.id);
}

async function runAtomShallow(
  def: AtomDef,
  state: RunState,
  readState: RunState,
  touched: Set<string>,
): Promise<void> {
  const start = Date.now();
  const deps: string[] = [];
  const prev = state.nodes[def.id];

  const get: Get = Object.assign(
    <T>(source: Handle<T>) => {
      assertHandle(source, "get");
      deps.push(source.__id);
      return readValueShallow(readState, state, source.__id, def.id) as T;
    },
    {
      maybe: <T>(source: Handle<T>) => {
        assertHandle(source, "get.maybe");
        deps.push(source.__id);
        try {
          return readValueShallow(readState, state, source.__id, def.id) as T;
        } catch (e) {
          if (e instanceof SkipError || e instanceof WaitError) return undefined;
          throw e;
        }
      },
      skip: (reason?: string): never => {
        throw new SkipError(def.id, reason);
      },
    },
  );

  try {
    const value = await def.fn(get);
    state.nodes[def.id] = nodeRecord("resolved", deps, start, prev, { value });
  } catch (e) {
    if (e instanceof SkipError) {
      state.nodes[def.id] = nodeRecord("skipped", deps, start, prev, {
        skipReason: e.reason,
      });
    } else if (e instanceof WaitError) {
      registerWaiter(state, e.inputId, def.id);
      state.nodes[def.id] = nodeRecord("waiting", deps, start, prev, { waitingOn: e.inputId });
    } else if (e instanceof NotReadyError) {
      registerWaiter(state, e.dependencyId, def.id);
      state.nodes[def.id] = nodeRecord("blocked", deps, start, prev, { blockedOn: e.dependencyId });
    } else {
      const err = e as Error;
      state.nodes[def.id] = nodeRecord("errored", deps, start, prev, {
        error: { message: err.message, stack: err.stack },
      });
    }
  }

  touched.add(def.id);
}

function assertHandle(source: unknown, method: string): asserts source is Handle {
  if (!isHandle(source)) {
    throw new Error(`${method}() called with non-handle value`);
  }
}

function readValueShallow(
  readState: RunState,
  writeState: RunState,
  depId: string,
  readerStepId: string,
): unknown {
  const existing = readState.nodes[depId];
  if (existing?.status === "resolved") return existing.value;
  if (existing?.status === "skipped") throw new SkipError(depId, existing.skipReason);
  if (existing?.status === "waiting") throw new WaitError(existing.waitingOn!);
  if (existing?.status === "blocked") throw new NotReadyError(existing.blockedOn!);
  if (existing?.status === "errored") {
    throw Object.assign(new Error(existing.error!.message), { stack: existing.error!.stack });
  }

  const inputDef = globalRegistry.getInput(depId);
  if (inputDef) {
    if (depId in readState.inputs) return readState.inputs[depId];
    if (inputDef.kind === "deferred_input") {
      registerWaiter(writeState, depId, readerStepId);
      throw new WaitError(depId);
    }
    throw new SkipError(depId);
  }

  if (globalRegistry.getAtom(depId)) {
    registerWaiter(writeState, depId, readerStepId);
    throw new NotReadyError(depId);
  }

  throw new Error(`Unknown id: ${depId}`);
}

function registerWaiter(state: RunState, depId: string, stepId: string): void {
  const waiters = state.waiters[depId] ?? [];
  if (!waiters.includes(stepId)) waiters.push(stepId);
  state.waiters[depId] = waiters;
}

function nodeRecord(
  status: NodeStatus,
  deps: string[],
  start: number,
  prev: NodeRecord | undefined,
  rest: Partial<NodeRecord> = {},
): NodeRecord {
  return {
    status,
    deps,
    duration_ms: Date.now() - start,
    attempts: (prev?.attempts ?? 0) + 1,
    ...rest,
  };
}

function buildGraphNodes(state: RunState, touched: Set<string>): GraphNode[] {
  return globalRegistry.allIds().map((id) => {
    const inputDef = globalRegistry.getInput(id);
    const atomDef = globalRegistry.getAtom(id);
    const rec = state.nodes[id] ?? fallbackRecord(id);
    const phase = phaseFor(id, rec, touched);
    return {
      id,
      kind: inputDef?.kind ?? "atom",
      description: inputDef?.description ?? atomDef?.description,
      status: rec.status,
      phase,
      label: phase.replaceAll("_", " "),
      value: rec.value,
      deps: rec.deps,
      blockedOn: rec.blockedOn,
      waitingOn: rec.waitingOn,
      skipReason: rec.skipReason,
      attempts: rec.attempts,
    };
  });
}

function fallbackRecord(id: string): NodeRecord {
  const inputDef = globalRegistry.getInput(id);
  if (inputDef?.kind === "input") {
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

function phaseFor(id: string, rec: NodeRecord, touched: Set<string>): GraphPhase {
  if (rec.status === "not_reached") return "not_reached";
  if (rec.status === "skipped" && rec.attempts === 0) return "skipped";
  if (touched.has(id)) return `${rec.status}_in_this_run` as GraphPhase;
  return `${rec.status}_previously` as GraphPhase;
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
