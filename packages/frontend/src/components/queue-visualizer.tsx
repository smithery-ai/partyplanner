import type {
  NodeRecord,
  NodeStatus,
  Registry,
  RunState,
} from "@workflow/core";
import type { QueueSnapshot } from "@workflow/runtime";
import {
  type ConnectionLineComponentProps,
  Controls,
  type Edge,
  MarkerType,
  type Node,
  Panel,
  ReactFlowProvider,
  useEdgesState,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas } from "../components/ai-elements/canvas";
import {
  NodeContent,
  NodeDescription,
  NodeFooter,
  NodeHeader,
  NodeTitle,
  Node as WorkflowCard,
} from "../components/ai-elements/node";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import type { WorkflowManifest } from "../types";

/** Visual bucket for theming (includes deferred-input gate) */
type QueueNodeStatus = "queued" | "running";
type StatusVisual =
  | NodeStatus
  | QueueNodeStatus
  | "needs_input"
  | "pending_input"
  | "intervention";

const STATUS_LEGEND: {
  key: StatusVisual;
  label: string;
  hint: string;
}[] = [
  {
    key: "queued",
    label: "Queued",
    hint: "Scheduled and waiting to execute",
  },
  {
    key: "running",
    label: "Running",
    hint: "Currently executing",
  },
  {
    key: "resolved",
    label: "Resolved",
    hint: "Step finished successfully",
  },
  {
    key: "waiting",
    label: "Waiting",
    hint: "Blocked until a dependency or input is ready",
  },
  {
    key: "needs_input",
    label: "Needs input",
    hint: "Deferred input required (e.g. approval)",
  },
  {
    key: "intervention",
    label: "Needs human input",
    hint: "A human must resolve this step before the run can continue",
  },
  {
    key: "pending_input",
    label: "Pending input",
    hint: "Submit this input or secret to continue",
  },
  {
    key: "skipped",
    label: "Skipped",
    hint: "Step did not run (e.g. branch not taken)",
  },
  {
    key: "blocked",
    label: "Blocked",
    hint: "Cannot run yet (upstream not ready)",
  },
  {
    key: "errored",
    label: "Errored",
    hint: "Step failed",
  },
];

type WorkflowNodeData = {
  label: string;
  kind: "input" | "atom" | "action";
  deferred?: boolean;
  secret?: boolean;
  /** Waiting on this input or secret (no node record in state until submitted). */
  pendingInput?: boolean;
  /** Step is waiting on a pending intervention (human input required). */
  intervention?: boolean;
  status?: NodeRecord["status"] | QueueNodeStatus;
  handles: { target: boolean; source: boolean };
  /** Inline approve/reject when a downstream step is blocked on this deferred input */
  inlineActions?: { approve: () => void; reject: () => void };
};

function statusVisual(data: WorkflowNodeData): StatusVisual {
  if (data.intervention) return "intervention";
  if (data.inlineActions) return "needs_input";
  if (data.pendingInput) return "pending_input";
  return data.status ?? "not_reached";
}

function statusNodeClasses(visual: StatusVisual): {
  card: string;
  header: string;
} {
  switch (visual) {
    case "queued":
      return {
        card: "border-muted-foreground/25 bg-muted/20 dark:bg-muted/15",
        header:
          "border-b border-muted-foreground/15 bg-muted/35 dark:bg-muted/25",
      };
    case "running":
      return {
        card: "border-indigo-600/45 ring-1 ring-indigo-600/15 dark:border-indigo-500/40",
        header:
          "border-b border-indigo-600/25 bg-indigo-600/12 dark:bg-indigo-500/14 dark:border-indigo-500/25",
      };
    case "resolved":
      return {
        card: "border-emerald-600/45 ring-1 ring-emerald-600/15 dark:border-emerald-500/40",
        header:
          "border-b border-emerald-600/25 bg-emerald-600/12 dark:bg-emerald-500/14 dark:border-emerald-500/25",
      };
    case "waiting":
      return {
        card: "border-sky-600/45 ring-1 ring-sky-600/15 dark:border-sky-500/40",
        header:
          "border-b border-sky-600/25 bg-sky-600/12 dark:bg-sky-500/14 dark:border-sky-500/25",
      };
    case "needs_input":
      return {
        card: "border-amber-600/50 ring-1 ring-amber-600/20 dark:border-amber-500/45",
        header:
          "border-b border-amber-600/30 bg-amber-600/14 dark:bg-amber-500/16 dark:border-amber-500/30",
      };
    case "pending_input":
      return {
        card: "border-yellow-500/55 ring-1 ring-yellow-500/25 dark:border-yellow-400/50",
        header:
          "border-b border-yellow-500/35 bg-yellow-400/18 dark:bg-yellow-400/14 dark:border-yellow-400/35",
      };
    case "intervention":
      return {
        card: "border-yellow-500/50 bg-yellow-400/15 text-yellow-950 dark:border-yellow-500/45 dark:bg-yellow-500/12 dark:text-yellow-50",
        header: "bg-transparent border-transparent",
      };
    case "skipped":
      return {
        card: "border-primary/55 ring-1 ring-primary/20",
        header: "border-b border-primary/30 bg-primary/12 dark:bg-primary/18",
      };
    case "blocked":
      return {
        card: "border-orange-600/45 ring-1 ring-orange-600/15 dark:border-orange-500/40",
        header:
          "border-b border-orange-600/25 bg-orange-600/12 dark:bg-orange-500/14 dark:border-orange-500/25",
      };
    case "errored":
      return {
        card: "border-destructive/55 ring-1 ring-destructive/20",
        header:
          "border-b border-destructive/30 bg-destructive/12 dark:bg-destructive/18",
      };
    default:
      return {
        card: "border-dashed border-muted-foreground/30 bg-muted/25 dark:bg-muted/20",
        header:
          "border-b border-muted-foreground/15 bg-muted/40 dark:bg-muted/30",
      };
  }
}

const STATUS_SWATCH: Record<StatusVisual, string> = {
  queued: "bg-muted/60 ring-1 ring-muted-foreground/15",
  running: "bg-indigo-600/45 ring-1 ring-indigo-600/25 dark:bg-indigo-500/35",
  resolved:
    "bg-emerald-600/45 ring-1 ring-emerald-600/25 dark:bg-emerald-500/35",
  waiting: "bg-sky-600/45 ring-1 ring-sky-600/25 dark:bg-sky-500/35",
  needs_input: "bg-amber-600/45 ring-1 ring-amber-600/25 dark:bg-amber-500/35",
  pending_input:
    "bg-yellow-400/50 ring-1 ring-yellow-500/30 dark:bg-yellow-400/35",
  intervention:
    "bg-yellow-400/15 ring-1 ring-yellow-500/50 dark:bg-yellow-500/12 dark:ring-yellow-500/45",
  skipped: "bg-primary/45 ring-1 ring-primary/25",
  blocked: "bg-orange-600/45 ring-1 ring-orange-600/25 dark:bg-orange-500/35",
  errored: "bg-destructive/40 ring-1 ring-destructive/25",
  not_reached: "bg-muted/60 ring-1 ring-muted-foreground/20",
};

const nodeTypes = {
  workflow: WorkflowNode,
};

const EDGE_MARKER = {
  type: MarkerType.ArrowClosed,
  width: 14,
  height: 14,
  color: "var(--muted-foreground)",
} as const;

/** Edges touching a pending deferred input node (matches node yellow accent). */
const PENDING_DEFERRED_EDGE_STYLE = {
  stroke: "#eab308",
  strokeWidth: 2,
} as const;

const PENDING_DEFERRED_EDGE_MARKER = {
  type: MarkerType.ArrowClosed,
  width: 14,
  height: 14,
  color: "#eab308",
} as const;

function ConnectionLine(props: ConnectionLineComponentProps) {
  const { fromX, fromY, toX, toY } = props;
  const mid = fromX + (toX - fromX) / 2;
  return (
    <g>
      <path
        className="animated"
        fill="none"
        stroke="var(--primary)"
        strokeWidth={2}
        d={`M${fromX},${fromY} C ${mid},${fromY} ${mid},${toY} ${toX},${toY}`}
      />
    </g>
  );
}

function dagHandleSides(
  nodeId: string,
  topology: {
    sources: ReadonlySet<string>;
    sinks: ReadonlySet<string>;
    isolated: (id: string) => boolean;
  },
): { target: boolean; source: boolean } {
  if (topology.isolated(nodeId)) return { target: true, source: true };
  const isSource = topology.sources.has(nodeId);
  const isSink = topology.sinks.has(nodeId);
  return {
    target: !isSource,
    source: !isSink,
  };
}

function WorkflowNode({ data }: { data: WorkflowNodeData }) {
  const handles = data.handles;

  const pendingInline = Boolean(data.inlineActions);

  const visual = statusVisual(data);
  const { card: cardStatus, header: headerStatus } = statusNodeClasses(visual);

  const kindLabel =
    data.kind === "input"
      ? data.secret
        ? "Secret"
        : data.deferred
          ? "Deferred input"
          : "Input"
      : data.kind === "action"
        ? "Action"
        : "Atom";

  return (
    <WorkflowCard
      handles={handles}
      className={cn(
        "!w-[11rem] max-w-[11rem] shadow-sm transition-colors duration-200",
        cardStatus,
      )}
    >
      <NodeHeader className={cn("p-2!", headerStatus)}>
        <NodeTitle className="text-xs font-medium leading-tight">
          {data.label}
        </NodeTitle>
        <NodeDescription className="text-[11px] leading-snug">
          {data.intervention ? (
            <>
              {kindLabel} ·{" "}
              <span className="font-medium text-yellow-950 dark:text-yellow-50">
                Needs human input
              </span>
            </>
          ) : pendingInline ? (
            <>
              {kindLabel} · <span className="text-foreground">needed</span>
            </>
          ) : data.pendingInput ? (
            <>
              {kindLabel} · <span className="text-foreground">pending</span>
            </>
          ) : (
            <>
              {kindLabel} ·{" "}
              <span className="text-foreground">
                {data.status ?? "not_reached"}
              </span>
            </>
          )}
        </NodeDescription>
      </NodeHeader>
      {pendingInline && data.inlineActions && (
        <>
          <NodeContent className="space-y-1.5 p-2! pt-0 text-[11px] leading-snug text-muted-foreground">
            <p>
              <span className="font-medium text-foreground">Blocked</span> — A
              downstream step is waiting on this input.
            </p>
          </NodeContent>
          <NodeFooter className="flex flex-col gap-1.5 p-2!">
            <Button
              type="button"
              size="sm"
              className="nodrag nopan h-7 w-full text-xs"
              onClick={() => data.inlineActions?.approve()}
            >
              Approve
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="nodrag nopan h-7 w-full text-xs"
              onClick={() => data.inlineActions?.reject()}
            >
              Reject
            </Button>
          </NodeFooter>
        </>
      )}
    </WorkflowCard>
  );
}

/** Horizontal gap between dependency layers (child column is strictly to the right of parents). */
const LAYOUT_COL_STEP = 240;
/** Vertical gap between nodes that share a layer. */
const LAYOUT_ROW_GAP = 96;

function compareIdsByOrder(
  registry: Registry,
  manifest: WorkflowManifest | undefined,
): (a: string, b: string) => number {
  const order = workflowNodeOrder(registry, manifest, undefined, undefined);
  return (a: string, b: string) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  };
}

function workflowNodeOrder(
  registry: Registry,
  manifest: WorkflowManifest | undefined,
  runState: RunState | undefined,
  queue: QueueSnapshot | undefined,
): string[] {
  const ids = new Set<string>();
  for (const id of registry.allIds()) ids.add(id);
  for (const input of manifest?.inputs ?? []) ids.add(input.id);
  for (const atom of manifest?.atoms ?? []) ids.add(atom.id);
  for (const action of manifest?.actions ?? []) ids.add(action.id);
  for (const id of Object.keys(runState?.nodes ?? {})) ids.add(id);
  for (const item of queue?.pending ?? []) ids.add(queueNodeId(item.event));
  for (const item of queue?.running ?? []) ids.add(queueNodeId(item.event));

  const manifestOrder = new Map(
    [
      ...(manifest?.inputs ?? []),
      ...(manifest?.atoms ?? []),
      ...(manifest?.actions ?? []),
    ].map((node, index) => [node.id, index]),
  );
  const registryOrder = new Map(
    registry.allIds().map((id, index) => [id, index + manifestOrder.size]),
  );
  return [...ids].sort((a, b) => {
    const ao = manifestOrder.get(a) ?? registryOrder.get(a) ?? 9999;
    const bo = manifestOrder.get(b) ?? registryOrder.get(b) ?? 9999;
    return ao === bo ? a.localeCompare(b) : ao - bo;
  });
}

function inputDefinition(
  registry: Registry,
  manifest: WorkflowManifest | undefined,
  id: string,
): { kind: "input" | "deferred_input"; secret?: boolean } | undefined {
  const registered = registry.getInput(id);
  if (registered) return registered;
  const input = manifest?.inputs.find((item) => item.id === id);
  return input ? { kind: input.kind, secret: input.secret } : undefined;
}

/**
 * Build the set of node IDs that should be hidden from the graph.
 *
 * A node is internal if:
 * 1. It has `internal: true` in the registry or manifest, OR
 * 2. Its ID starts with `@workflow/integrations-` (package-internal atoms), OR
 * 3. It is a resolved secret whose ONLY consumers are themselves internal
 *    (transitive — covers infra secrets like HYLO_BACKEND_URL fed only into
 *    integration atoms).
 */
function internalNodeIds(
  registry: Registry,
  manifest: WorkflowManifest | undefined,
  runState: RunState | undefined,
): Set<string> {
  const result = new Set<string>();

  // Collect all known node IDs.
  const allIds = new Set<string>();
  for (const id of registry.allIds()) allIds.add(id);
  if (manifest) {
    for (const i of manifest.inputs) allIds.add(i.id);
    for (const a of manifest.atoms) allIds.add(a.id);
    for (const a of manifest.actions) allIds.add(a.id);
  }
  if (runState) {
    for (const id of Object.keys(runState.nodes)) allIds.add(id);
  }

  // Pass 1: flag nodes that are explicitly internal or match the
  // @workflow/integrations-* convention.
  for (const id of allIds) {
    if (isExplicitlyInternal(registry, manifest, id)) {
      result.add(id);
    } else if (id.startsWith("@workflow/integrations-")) {
      result.add(id);
    }
  }

  // Pass 2: resolved secrets consumed *only* by already-internal nodes.
  if (runState) {
    // Build consumer map: nodeId → set of IDs that depend on it.
    const consumers = new Map<string, string[]>();
    for (const [nid, rec] of Object.entries(runState.nodes)) {
      for (const dep of rec?.deps ?? []) {
        let list = consumers.get(dep);
        if (!list) {
          list = [];
          consumers.set(dep, list);
        }
        list.push(nid);
      }
    }

    let changed = true;
    while (changed) {
      changed = false;
      for (const id of allIds) {
        if (result.has(id)) continue;
        const def = inputDefinition(registry, manifest, id);
        if (!def?.secret) continue;
        const rec = runState.nodes[id];
        if (!rec || rec.status !== "resolved") continue;
        const deps = consumers.get(id);
        if (deps && deps.length > 0 && deps.every((c) => result.has(c))) {
          result.add(id);
          changed = true;
        }
      }
    }
  }

  return result;
}

function isExplicitlyInternal(
  registry: Registry,
  manifest: WorkflowManifest | undefined,
  id: string,
): boolean {
  const regInput = registry.getInput(id);
  if (regInput) return Boolean(regInput.internal);
  const regAtom = registry.getAtom(id);
  if (regAtom) return Boolean(regAtom.internal);
  const regAction = registry.getAction(id);
  if (regAction) return Boolean(regAction.internal);
  const mInput = manifest?.inputs.find((item) => item.id === id);
  if (mInput) return Boolean(mInput.internal);
  const mAtom = manifest?.atoms.find((item) => item.id === id);
  if (mAtom) return Boolean(mAtom.internal);
  const mAction = manifest?.actions.find((item) => item.id === id);
  if (mAction) return Boolean(mAction.internal);
  return false;
}

function flowTopology(
  nodeIds: readonly string[],
  edges: readonly { source: string; target: string }[],
): {
  sources: ReadonlySet<string>;
  sinks: ReadonlySet<string>;
  isolated: (id: string) => boolean;
} {
  const indeg = new Map<string, number>();
  const outdeg = new Map<string, number>();
  const incident = new Set<string>();
  for (const id of nodeIds) {
    indeg.set(id, 0);
    outdeg.set(id, 0);
  }
  for (const e of edges) {
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
    outdeg.set(e.source, (outdeg.get(e.source) ?? 0) + 1);
    incident.add(e.source);
    incident.add(e.target);
  }
  const sources = new Set<string>();
  const sinks = new Set<string>();
  for (const id of nodeIds) {
    if ((indeg.get(id) ?? 0) === 0) sources.add(id);
    if ((outdeg.get(id) ?? 0) === 0) sinks.add(id);
  }
  return {
    sources,
    sinks,
    isolated: (id: string) => !incident.has(id),
  };
}

/**
 * Kahn topological order over the workflow DAG. All `nodeIds` appear exactly once.
 */
function topologicalSort(
  nodeIds: readonly string[],
  edges: readonly { source: string; target: string }[],
  cmp: (a: string, b: string) => number,
): string[] {
  const outgoing = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const id of nodeIds) {
    outgoing.set(id, []);
    indeg.set(id, 0);
  }
  for (const e of edges) {
    outgoing.get(e.source)?.push(e.target);
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  }
  const q: string[] = [];
  for (const id of nodeIds) {
    if ((indeg.get(id) ?? 0) === 0) q.push(id);
  }
  q.sort(cmp);
  const order: string[] = [];
  while (q.length > 0) {
    const u = q.shift();
    if (u === undefined) break;
    order.push(u);
    const outs = [...(outgoing.get(u) ?? [])].sort(cmp);
    for (const v of outs) {
      indeg.set(v, (indeg.get(v) ?? 0) - 1);
      if (indeg.get(v) === 0) {
        let i = 0;
        while (i < q.length) {
          const queued = q[i];
          if (queued === undefined || cmp(queued, v) > 0) break;
          i++;
        }
        q.splice(i, 0, v);
      }
    }
  }
  if (order.length !== nodeIds.length) {
    // Should not happen for this workflow graph; fall back to declaration order
    return [...nodeIds];
  }
  return order;
}

/**
 * Layer = longest path from any source: guarantees every edge goes left → right.
 * Within each layer, nodes are stacked with even vertical spacing and column-centered.
 */
function computeWorkflowLayout(
  nodeIds: readonly string[],
  edges: readonly { source: string; target: string }[],
  cmp: (a: string, b: string) => number,
): Record<string, { x: number; y: number }> {
  const parents = new Map<string, string[]>();
  for (const id of nodeIds) parents.set(id, []);
  for (const e of edges) {
    parents.get(e.target)?.push(e.source);
  }

  const topo = topologicalSort(nodeIds, edges, cmp);
  const layer = new Map<string, number>();
  for (const id of topo) {
    const ps = parents.get(id) ?? [];
    layer.set(
      id,
      ps.length === 0 ? 0 : Math.max(...ps.map((p) => layer.get(p) ?? 0)) + 1,
    );
  }

  const byLayer = new Map<number, string[]>();
  let maxLayer = 0;
  for (const id of nodeIds) {
    const L = layer.get(id) ?? 0;
    maxLayer = Math.max(maxLayer, L);
    if (!byLayer.has(L)) byLayer.set(L, []);
    byLayer.get(L)?.push(id);
  }
  for (let L = 0; L <= maxLayer; L++) {
    const row = byLayer.get(L);
    if (row) row.sort(cmp);
  }

  const maxCount = Math.max(
    1,
    ...[...byLayer.values()].map((ids) => ids.length),
  );
  const columnSpan = (maxCount - 1) * LAYOUT_ROW_GAP;

  const positions: Record<string, { x: number; y: number }> = {};
  for (let L = 0; L <= maxLayer; L++) {
    const ids = byLayer.get(L);
    if (!ids?.length) continue;
    const n = ids.length;
    const colSpan = (n - 1) * LAYOUT_ROW_GAP;
    const y0 = (columnSpan - colSpan) / 2;
    ids.forEach((id, i) => {
      positions[id] = { x: L * LAYOUT_COL_STEP, y: y0 + i * LAYOUT_ROW_GAP };
    });
  }
  return positions;
}

function edgeIdFromEndpoints(source: string, target: string): string {
  return `${source}->${target}`;
}

/**
 * Edges discovered from runtime: each atom/input record lists `deps` (handles read in execution order).
 * Only paths that actually ran contribute; the graph grows as the run explores branches.
 */
function edgesFromObservedDeps(
  state: RunState | undefined,
): { id: string; source: string; target: string }[] {
  if (!state) return [];
  const out: { id: string; source: string; target: string }[] = [];
  const seen = new Set<string>();
  for (const [id, rec] of Object.entries(state.nodes)) {
    const deps = rec?.deps ?? [];
    for (const dep of new Set(deps)) {
      const idStr = edgeIdFromEndpoints(dep, id);
      if (seen.has(idStr)) continue;
      seen.add(idStr);
      out.push({ id: idStr, source: dep, target: id });
    }
  }
  return out;
}

/** Pulse dependency edges that explain current waiting / blocked steps. */
function animatedEdgesFromState(state: RunState | undefined): Set<string> {
  if (!state) return new Set();
  const s = new Set<string>();
  for (const [id, n] of Object.entries(state.nodes)) {
    if (n.status === "waiting" && n.waitingOn) {
      s.add(edgeIdFromEndpoints(n.waitingOn, id));
    }
    if (n.status === "blocked" && n.blockedOn) {
      s.add(edgeIdFromEndpoints(n.blockedOn, id));
    }
  }
  return s;
}

/**
 * A deferred input is “in play” when a step is blocked waiting for it, even though
 * `state.nodes[inputId]` does not exist until the user submits that input.
 */
/** Exported for the node detail sheet (pending deferred inputs have no `state.nodes` record yet). */
export function workflowInputRequested(
  registry: Registry,
  manifest: WorkflowManifest | undefined,
  runState: RunState,
  id: string,
): boolean {
  const def = inputDefinition(registry, manifest, id);
  if (!def) return false;
  if (!def.secret && runState.nodes[id]?.status === "resolved") return false;
  if (runState.waiters[id]?.length) return true;
  for (const n of Object.values(runState.nodes)) {
    if (n.status === "waiting" && n.waitingOn === id) return true;
  }
  return false;
}

/** Exported for older callers that only care about deferred gates. */
export function deferredInputRequested(
  registry: Registry,
  manifest: WorkflowManifest | undefined,
  runState: RunState,
  id: string,
): boolean {
  const def = inputDefinition(registry, manifest, id);
  return Boolean(
    def?.kind === "deferred_input" &&
      workflowInputRequested(registry, manifest, runState, id),
  );
}

/** Nodes that have been evaluated, plus inputs currently awaited by a step. */
function visibleWorkflowNodeIds(
  registry: Registry,
  manifest: WorkflowManifest | undefined,
  runState: RunState | undefined,
  queue: QueueSnapshot | undefined,
): string[] {
  if (!runState) return [];
  const hidden = internalNodeIds(registry, manifest, runState);
  const queuedIds = new Set([
    ...(queue?.pending ?? []).map((item) => queueNodeId(item.event)),
    ...(queue?.running ?? []).map((item) => queueNodeId(item.event)),
  ]);
  return workflowNodeOrder(registry, manifest, runState, queue).filter((id) => {
    if (hidden.has(id)) return false;
    const rec = runState.nodes[id];
    if (rec && rec.status !== "not_reached") return true;
    if (queuedIds.has(id)) return true;
    return workflowInputRequested(registry, manifest, runState, id);
  });
}

function skippedWorkflowNodeIds(
  ids: readonly string[],
  runState: RunState | undefined,
): string[] {
  if (!runState) return [];
  return ids.filter((id) => runState.nodes[id]?.status === "skipped");
}

function queueNodeId(event: QueueSnapshot["pending"][number]["event"]): string {
  return event.kind === "input" ? event.inputId : event.stepId;
}

function buildFlow(
  registry: Registry,
  manifest: WorkflowManifest | undefined,
  visibleIds: readonly string[],
  graphEdges: readonly { id: string; source: string; target: string }[],
  layout: Record<string, { x: number; y: number }>,
  topology: ReturnType<typeof flowTopology>,
  runState: RunState | undefined,
  queue: QueueSnapshot | undefined,
  nodeInlineActions:
    | Record<string, { approve: () => void; reject: () => void }>
    | undefined,
): { nodes: Node[]; edges: Edge[] } {
  const ids = visibleIds;
  const animate = animatedEdgesFromState(runState);
  const queuedIds = new Set(
    (queue?.pending ?? []).map((item) => queueNodeId(item.event)),
  );
  const runningIds = new Set(
    (queue?.running ?? []).map((item) => queueNodeId(item.event)),
  );

  const nodes: Node[] = ids.map((id) => {
    const rec = runState?.nodes[id];
    const inputDef = inputDefinition(registry, manifest, id);
    const actionDef =
      registry.getAction(id) ??
      manifest?.actions.find((item) => item.id === id);
    const kind: WorkflowNodeData["kind"] = inputDef
      ? "input"
      : actionDef
        ? "action"
        : "atom";
    const deferred = Boolean(inputDef?.kind === "deferred_input");
    const secret = Boolean(inputDef?.secret);
    const pendingInput = Boolean(
      runState &&
        inputDef &&
        workflowInputRequested(registry, manifest, runState, id) &&
        !rec,
    );
    const waitingInterventionId =
      rec?.status === "waiting" && rec.waitingOn ? rec.waitingOn : undefined;
    const intervention = Boolean(
      waitingInterventionId &&
        runState?.interventions?.[waitingInterventionId] &&
        runState.interventions[waitingInterventionId]?.status !== "resolved",
    );
    const data: WorkflowNodeData = {
      label: id,
      kind,
      deferred,
      secret,
      pendingInput,
      intervention,
      status: runningIds.has(id)
        ? "running"
        : queuedIds.has(id)
          ? "queued"
          : (rec?.status ?? "not_reached"),
      handles: dagHandleSides(id, topology),
    };
    const actions = nodeInlineActions?.[id];
    if (actions) data.inlineActions = actions;
    return {
      id,
      type: "workflow",
      position: layout[id] ?? { x: 0, y: 0 },
      data,
    };
  });

  const pendingInputIdSet = new Set(
    ids.filter((nid) => {
      const r = runState?.nodes[nid];
      const inputDef = inputDefinition(registry, manifest, nid);
      return Boolean(
        runState &&
          inputDef &&
          workflowInputRequested(registry, manifest, runState, nid) &&
          !r,
      );
    }),
  );

  const edges: Edge[] = graphEdges.map((e) => {
    const touchesPendingInput =
      pendingInputIdSet.has(e.source) || pendingInputIdSet.has(e.target);
    return {
      ...e,
      animated: animate.has(e.id),
      ...(touchesPendingInput
        ? {
            style: PENDING_DEFERRED_EDGE_STYLE,
            markerEnd: PENDING_DEFERRED_EDGE_MARKER,
          }
        : {}),
    };
  });

  return { nodes, edges };
}

function FlowInner({
  runState,
  queue,
  registry,
  manifest,
  nodeInlineActions,
  onNodeClick,
}: {
  runState: RunState | undefined;
  queue: QueueSnapshot | undefined;
  registry: Registry;
  manifest?: WorkflowManifest;
  nodeInlineActions?: Record<
    string,
    { approve: () => void; reject: () => void }
  >;
  onNodeClick?: (nodeId: string) => void;
}) {
  const [legendOpen, setLegendOpen] = useState(false);
  const [showSkippedNodes, setShowSkippedNodes] = useState(false);
  const [fitViewRevision, setFitViewRevision] = useState(0);
  const prevEdgeSigRef = useRef<string | null>(null);
  const prevNodeIdsRef = useRef<Set<string> | null>(null);
  const lastFitViewRevisionRef = useRef(0);
  const nodesInitialized = useNodesInitialized();
  const { fitView } = useReactFlow();

  const reachableIds = useMemo(
    () => visibleWorkflowNodeIds(registry, manifest, runState, queue),
    [registry, manifest, runState, queue],
  );
  const skippedIds = useMemo(
    () => skippedWorkflowNodeIds(reachableIds, runState),
    [reachableIds, runState],
  );
  const visibleIds = useMemo(() => {
    if (showSkippedNodes) return reachableIds;
    const skipped = new Set(skippedIds);
    return reachableIds.filter((id) => !skipped.has(id));
  }, [reachableIds, skippedIds, showSkippedNodes]);
  const skippedNodeCount = skippedIds.length;

  const graphEdges = useMemo(() => {
    const raw = edgesFromObservedDeps(runState);
    const vis = new Set(visibleIds);
    return raw.filter((e) => vis.has(e.source) && vis.has(e.target));
  }, [runState, visibleIds]);

  const edgeSig = useMemo(
    () =>
      graphEdges
        .map((e) => e.id)
        .sort()
        .join("|"),
    [graphEdges],
  );

  const cmp = useMemo(
    () => compareIdsByOrder(registry, manifest),
    [registry, manifest],
  );
  const layout = useMemo(
    () => computeWorkflowLayout(visibleIds, graphEdges, cmp),
    [visibleIds, graphEdges, cmp],
  );
  const topology = useMemo(
    () => flowTopology(visibleIds, graphEdges),
    [visibleIds, graphEdges],
  );

  const { nodes: nextNodes, edges: nextEdges } = useMemo(
    () =>
      buildFlow(
        registry,
        manifest,
        visibleIds,
        graphEdges,
        layout,
        topology,
        runState,
        queue,
        nodeInlineActions,
      ),
    [
      registry,
      manifest,
      visibleIds,
      graphEdges,
      layout,
      topology,
      runState,
      queue,
      nodeInlineActions,
    ],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(nextNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(nextEdges);

  useEffect(() => {
    const isFirst = prevEdgeSigRef.current === null;
    const edgesChanged = !isFirst && prevEdgeSigRef.current !== edgeSig;
    const prevNodeIds = prevNodeIdsRef.current;
    const nextNodeIds = new Set(nextNodes.map((node) => node.id));
    const nodeIdsChanged =
      prevNodeIds === null ||
      prevNodeIds.size !== nextNodeIds.size ||
      nextNodes.some((node) => !prevNodeIds.has(node.id));
    prevEdgeSigRef.current = edgeSig;
    prevNodeIdsRef.current = nextNodeIds;

    setNodes((current) => {
      if (isFirst || edgesChanged) return nextNodes;
      return nextNodes.map((fresh) => {
        const existing = current.find((c) => c.id === fresh.id);
        return existing ? { ...fresh, position: existing.position } : fresh;
      });
    });
    setEdges(nextEdges);

    if (nextNodes.length > 0 && (isFirst || edgesChanged || nodeIdsChanged)) {
      setFitViewRevision((revision) => revision + 1);
    }
  }, [nextNodes, nextEdges, edgeSig, setNodes, setEdges]);

  useEffect(() => {
    if (
      fitViewRevision === 0 ||
      fitViewRevision === lastFitViewRevisionRef.current ||
      nodes.length === 0 ||
      !nodesInitialized
    ) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      void fitView({ padding: 0.2, duration: 350 });
      lastFitViewRevisionRef.current = fitViewRevision;
    });

    return () => window.cancelAnimationFrame(frame);
  }, [fitView, fitViewRevision, nodes.length, nodesInitialized]);

  return (
    <Canvas
      className="[&_.react-flow__node:not(.dragging)]:transition-transform [&_.react-flow__node:not(.dragging)]:duration-300 [&_.react-flow__node:not(.dragging)]:ease-out"
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      nodesDraggable
      nodesConnectable={false}
      elementsSelectable
      connectionLineComponent={ConnectionLine}
      defaultEdgeOptions={{
        markerEnd: EDGE_MARKER,
        style: { stroke: "var(--border)", strokeWidth: 1.5 },
      }}
      fitView
      fitViewOptions={{ padding: 0.2 }}
      proOptions={{ hideAttribution: true }}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={(_, node) => {
        onNodeClick?.(node.id);
      }}
    >
      <Controls
        className={cn(
          "overflow-hidden rounded-md border border-border bg-card shadow-sm",
          "[&_button]:border-none [&_button]:bg-transparent [&_button]:hover:bg-muted",
        )}
        position="top-right"
        showInteractive={false}
      />
      <Panel
        className="rounded-md border border-border bg-card/90 px-3 py-2 text-xs text-muted-foreground shadow-sm backdrop-blur-sm"
        position="top-left"
      >
        Reached and queued steps · click a node for details · drag to pan ·
        scroll to zoom
      </Panel>
      <Panel
        className="mb-2 mr-2 flex max-w-[min(19rem,calc(100vw-1rem))] flex-col items-end gap-2"
        position="bottom-right"
      >
        {legendOpen && (
          <div
            className="nodrag nopan max-h-[min(55vh,400px)] w-full overflow-y-auto rounded-lg border border-border bg-card/95 p-3 text-xs shadow-lg backdrop-blur-sm"
            onPointerDown={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Status color legend"
          >
            <p className="mb-2.5 font-medium text-foreground">Status colors</p>
            <ul className="space-y-2.5">
              {STATUS_LEGEND.map((row) => (
                <li key={row.key} className="flex gap-2.5">
                  <div
                    className={cn(
                      "mt-0.5 size-5 shrink-0 rounded-sm border border-border/50",
                      STATUS_SWATCH[row.key],
                    )}
                    aria-hidden
                  />
                  <div className="min-w-0">
                    <div className="font-medium text-foreground">
                      {row.label}
                    </div>
                    <div className="text-[11px] text-muted-foreground leading-snug">
                      {row.hint}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="nodrag nopan flex flex-wrap items-center justify-end gap-2">
          {skippedNodeCount > 0 ? (
            <label className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-md border border-border bg-card/95 px-3 text-xs font-medium text-foreground shadow-md backdrop-blur-sm">
              <input
                type="checkbox"
                className="size-3.5 rounded border-border accent-primary"
                checked={showSkippedNodes}
                onChange={(event) => setShowSkippedNodes(event.target.checked)}
              />
              <span>Show {skippedNodeCount} skipped</span>
            </label>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="shadow-md"
            onClick={() => setLegendOpen((o) => !o)}
          >
            {legendOpen ? "Hide status key" : "Status colors"}
          </Button>
        </div>
      </Panel>
    </Canvas>
  );
}

export type QueueVisualizerProps = {
  runState: RunState | undefined;
  queue?: QueueSnapshot;
  /** Registry for node list and input vs atom (after importing your workflow module). */
  registry: Registry;
  /** Manifest inputs are used when the browser has not imported workflow code. */
  manifest?: WorkflowManifest;
  /** Optional: inline actions on a node (e.g. approve/reject on a deferred input). */
  nodeInlineActions?: Record<
    string,
    { approve: () => void; reject: () => void }
  >;
  /** When set, clicking a workflow node opens details (e.g. sheet in parent). */
  onNodeClick?: (nodeId: string) => void;
  className?: string;
};

export function QueueVisualizer({
  runState,
  queue,
  registry,
  manifest,
  nodeInlineActions,
  onNodeClick,
  className,
}: QueueVisualizerProps) {
  return (
    <div className={cn("h-full min-h-0 w-full min-w-0 bg-sidebar", className)}>
      <ReactFlowProvider>
        <FlowInner
          runState={runState}
          queue={queue}
          registry={registry}
          manifest={manifest}
          nodeInlineActions={nodeInlineActions}
          onNodeClick={onNodeClick}
        />
      </ReactFlowProvider>
    </div>
  );
}
