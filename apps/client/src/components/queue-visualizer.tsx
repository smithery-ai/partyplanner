import {
  Controls,
  type ConnectionLineComponentProps,
  type Edge,
  MarkerType,
  type Node,
  Panel,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
} from "@xyflow/react"
import { useEffect, useMemo, useRef, useState } from "react"

import { Canvas } from "@/components/ai-elements/canvas"
import {
  Node as WorkflowCard,
  NodeContent,
  NodeDescription,
  NodeFooter,
  NodeHeader,
  NodeTitle,
} from "@/components/ai-elements/node"
import { Button } from "@/components/ui/button"
import type { NodeRecord, NodeStatus, Registry, RunState } from "@rxwf/core"
import { cn } from "@/lib/utils"

/** Visual bucket for theming (includes deferred-input gate) */
type StatusVisual = NodeStatus | "needs_input"

const STATUS_LEGEND: {
  key: StatusVisual
  label: string
  hint: string
}[] = [
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
  {
    key: "not_reached",
    label: "Not reached",
    hint: "Not executed in this run yet",
  },
]

type WorkflowNodeData = {
  label: string
  kind: "input" | "atom"
  deferred?: boolean
  status?: NodeRecord["status"]
  detail?: string
  handles: { target: boolean; source: boolean }
  /** Inline approve/reject when a downstream step is blocked on this deferred input */
  inlineActions?: { approve: () => void; reject: () => void }
}

function statusVisual(data: WorkflowNodeData): StatusVisual {
  if (data.inlineActions) return "needs_input"
  return data.status ?? "not_reached"
}

function statusNodeClasses(visual: StatusVisual): { card: string; header: string } {
  switch (visual) {
    case "resolved":
      return {
        card: "border-emerald-600/45 ring-1 ring-emerald-600/15 dark:border-emerald-500/40",
        header:
          "border-b border-emerald-600/25 bg-emerald-600/12 dark:bg-emerald-500/14 dark:border-emerald-500/25",
      }
    case "waiting":
      return {
        card: "border-sky-600/45 ring-1 ring-sky-600/15 dark:border-sky-500/40",
        header:
          "border-b border-sky-600/25 bg-sky-600/12 dark:bg-sky-500/14 dark:border-sky-500/25",
      }
    case "needs_input":
      return {
        card: "border-amber-600/50 ring-1 ring-amber-600/20 dark:border-amber-500/45",
        header:
          "border-b border-amber-600/30 bg-amber-600/14 dark:bg-amber-500/16 dark:border-amber-500/30",
      }
    case "skipped":
      return {
        card: "border-muted-foreground/35 ring-1 ring-muted-foreground/10",
        header: "border-b border-muted-foreground/20 bg-muted/70 dark:bg-muted/50",
      }
    case "blocked":
      return {
        card: "border-orange-600/45 ring-1 ring-orange-600/15 dark:border-orange-500/40",
        header:
          "border-b border-orange-600/25 bg-orange-600/12 dark:bg-orange-500/14 dark:border-orange-500/25",
      }
    case "errored":
      return {
        card: "border-destructive/55 ring-1 ring-destructive/20",
        header: "border-b border-destructive/30 bg-destructive/12 dark:bg-destructive/18",
      }
    case "not_reached":
    default:
      return {
        card: "border-dashed border-muted-foreground/30 bg-muted/25 dark:bg-muted/20",
        header: "border-b border-muted-foreground/15 bg-muted/40 dark:bg-muted/30",
      }
  }
}

const STATUS_SWATCH: Record<StatusVisual, string> = {
  resolved: "bg-emerald-600/45 ring-1 ring-emerald-600/25 dark:bg-emerald-500/35",
  waiting: "bg-sky-600/45 ring-1 ring-sky-600/25 dark:bg-sky-500/35",
  needs_input: "bg-amber-600/45 ring-1 ring-amber-600/25 dark:bg-amber-500/35",
  skipped: "bg-muted-foreground/25 ring-1 ring-muted-foreground/15",
  blocked: "bg-orange-600/45 ring-1 ring-orange-600/25 dark:bg-orange-500/35",
  errored: "bg-destructive/40 ring-1 ring-destructive/25",
  not_reached: "bg-muted/60 ring-1 ring-muted-foreground/20",
}

const nodeTypes = {
  workflow: WorkflowNode,
}

const EDGE_MARKER = {
  type: MarkerType.ArrowClosed,
  width: 14,
  height: 14,
  color: "var(--muted-foreground)",
} as const

function ConnectionLine(props: ConnectionLineComponentProps) {
  const { fromX, fromY, toX, toY } = props
  const mid = fromX + (toX - fromX) / 2
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
  )
}

function dagHandleSides(
  nodeId: string,
  topology: {
    sources: ReadonlySet<string>
    sinks: ReadonlySet<string>
    isolated: (id: string) => boolean
  },
): { target: boolean; source: boolean } {
  if (topology.isolated(nodeId)) return { target: true, source: true }
  const isSource = topology.sources.has(nodeId)
  const isSink = topology.sinks.has(nodeId)
  return {
    target: !isSource,
    source: !isSink,
  }
}

function WorkflowNode({
  data,
}: {
  data: WorkflowNodeData
}) {
  const handles = data.handles

  const pendingInline = Boolean(data.inlineActions)

  const visual = statusVisual(data)
  const { card: cardStatus, header: headerStatus } = statusNodeClasses(visual)

  const kindLabel =
    data.kind === "input"
      ? data.deferred
        ? "Deferred input"
        : "Input"
      : "Atom"

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
          {pendingInline ? (
            <>
              {kindLabel} ·{" "}
              <span className="text-foreground">needed</span>
            </>
          ) : (
            <>
              {kindLabel} ·{" "}
              <span className="text-foreground">{data.status ?? "not_reached"}</span>
            </>
          )}
        </NodeDescription>
      </NodeHeader>
      {pendingInline && data.inlineActions && (
        <>
          <NodeContent className="space-y-1.5 p-2! pt-0 text-[11px] leading-snug text-muted-foreground">
            <p>
              <span className="font-medium text-foreground">Blocked</span> —{" "}
              A downstream step is waiting on this input.
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
      {!pendingInline && data.detail && (
        <NodeContent className="break-words pt-0 text-[11px] leading-snug text-muted-foreground p-2!">
          {data.detail}
        </NodeContent>
      )}
    </WorkflowCard>
  )
}

/** Horizontal gap between dependency layers (child column is strictly to the right of parents). */
const LAYOUT_COL_STEP = 240
/** Vertical gap between nodes that share a layer. */
const LAYOUT_ROW_GAP = 96

function compareIdsByRegistry(registry: Registry): (a: string, b: string) => number {
  const order = registry.allIds()
  return (a: string, b: string) => {
    const ia = order.indexOf(a)
    const ib = order.indexOf(b)
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib)
  }
}

function flowTopology(
  nodeIds: readonly string[],
  edges: readonly { source: string; target: string }[],
): {
  sources: ReadonlySet<string>
  sinks: ReadonlySet<string>
  isolated: (id: string) => boolean
} {
  const indeg = new Map<string, number>()
  const outdeg = new Map<string, number>()
  const incident = new Set<string>()
  for (const id of nodeIds) {
    indeg.set(id, 0)
    outdeg.set(id, 0)
  }
  for (const e of edges) {
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1)
    outdeg.set(e.source, (outdeg.get(e.source) ?? 0) + 1)
    incident.add(e.source)
    incident.add(e.target)
  }
  const sources = new Set<string>()
  const sinks = new Set<string>()
  for (const id of nodeIds) {
    if ((indeg.get(id) ?? 0) === 0) sources.add(id)
    if ((outdeg.get(id) ?? 0) === 0) sinks.add(id)
  }
  return {
    sources,
    sinks,
    isolated: (id: string) => !incident.has(id),
  }
}

/**
 * Kahn topological order over the workflow DAG. All `nodeIds` appear exactly once.
 */
function topologicalSort(
  nodeIds: readonly string[],
  edges: readonly { source: string; target: string }[],
  cmp: (a: string, b: string) => number,
): string[] {
  const outgoing = new Map<string, string[]>()
  const indeg = new Map<string, number>()
  for (const id of nodeIds) {
    outgoing.set(id, [])
    indeg.set(id, 0)
  }
  for (const e of edges) {
    outgoing.get(e.source)!.push(e.target)
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1)
  }
  const q: string[] = []
  for (const id of nodeIds) {
    if ((indeg.get(id) ?? 0) === 0) q.push(id)
  }
  q.sort(cmp)
  const order: string[] = []
  while (q.length > 0) {
    const u = q.shift()!
    order.push(u)
    const outs = [...(outgoing.get(u) ?? [])].sort(cmp)
    for (const v of outs) {
      indeg.set(v, (indeg.get(v) ?? 0) - 1)
      if (indeg.get(v) === 0) {
        let i = 0
        while (i < q.length && cmp(q[i]!, v) <= 0) i++
        q.splice(i, 0, v)
      }
    }
  }
  if (order.length !== nodeIds.length) {
    // Should not happen for this workflow graph; fall back to declaration order
    return [...nodeIds]
  }
  return order
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
  const parents = new Map<string, string[]>()
  for (const id of nodeIds) parents.set(id, [])
  for (const e of edges) {
    parents.get(e.target)!.push(e.source)
  }

  const topo = topologicalSort(nodeIds, edges, cmp)
  const layer = new Map<string, number>()
  for (const id of topo) {
    const ps = parents.get(id) ?? []
    layer.set(
      id,
      ps.length === 0 ? 0 : Math.max(...ps.map((p) => layer.get(p) ?? 0)) + 1,
    )
  }

  const byLayer = new Map<number, string[]>()
  let maxLayer = 0
  for (const id of nodeIds) {
    const L = layer.get(id) ?? 0
    maxLayer = Math.max(maxLayer, L)
    if (!byLayer.has(L)) byLayer.set(L, [])
    byLayer.get(L)!.push(id)
  }
  for (let L = 0; L <= maxLayer; L++) {
    const row = byLayer.get(L)
    if (row) row.sort(cmp)
  }

  const maxCount = Math.max(
    1,
    ...[...byLayer.values()].map((ids) => ids.length),
  )
  const columnSpan = (maxCount - 1) * LAYOUT_ROW_GAP

  const positions: Record<string, { x: number; y: number }> = {}
  for (let L = 0; L <= maxLayer; L++) {
    const ids = byLayer.get(L)
    if (!ids?.length) continue
    const n = ids.length
    const colSpan = (n - 1) * LAYOUT_ROW_GAP
    const y0 = (columnSpan - colSpan) / 2
    for (let i = 0; i < n; i++) {
      const id = ids[i]!
      positions[id] = { x: L * LAYOUT_COL_STEP, y: y0 + i * LAYOUT_ROW_GAP }
    }
  }
  return positions
}

function edgeIdFromEndpoints(source: string, target: string): string {
  return `${source}->${target}`
}

/**
 * Edges discovered from runtime: each atom/input record lists `deps` (handles read in execution order).
 * Only paths that actually ran contribute; the graph grows as the run explores branches.
 */
function edgesFromObservedDeps(
  registry: Registry,
  state: RunState | undefined,
): { id: string; source: string; target: string }[] {
  if (!state) return []
  const out: { id: string; source: string; target: string }[] = []
  const seen = new Set<string>()
  for (const id of registry.allIds()) {
    const rec = state.nodes[id]
    const deps = rec?.deps ?? []
    for (const dep of new Set(deps)) {
      const idStr = edgeIdFromEndpoints(dep, id)
      if (seen.has(idStr)) continue
      seen.add(idStr)
      out.push({ id: idStr, source: dep, target: id })
    }
  }
  return out
}

/** Pulse dependency edges that explain current waiting / blocked steps. */
function animatedEdgesFromState(state: RunState | undefined): Set<string> {
  if (!state) return new Set()
  const s = new Set<string>()
  for (const [id, n] of Object.entries(state.nodes)) {
    if (n.status === "waiting" && n.waitingOn) {
      s.add(edgeIdFromEndpoints(n.waitingOn, id))
    }
    if (n.status === "blocked" && n.blockedOn) {
      s.add(edgeIdFromEndpoints(n.blockedOn, id))
    }
  }
  return s
}

function statusDetail(rec: NodeRecord | undefined): string | undefined {
  if (!rec) return undefined
  if (rec.status === "waiting" && rec.waitingOn) {
    if (rec.deps.includes(rec.waitingOn)) return undefined
    return `Waiting on “${rec.waitingOn}”`
  }
  if (rec.status === "resolved" && rec.value !== undefined) {
    const v = rec.value
    const s = typeof v === "string" ? v : JSON.stringify(v)
    return s.length > 120 ? `${s.slice(0, 117)}…` : s
  }
  if (rec.status === "errored" && rec.error) {
    return rec.error.message
  }
  return undefined
}

function buildFlow(
  registry: Registry,
  graphEdges: readonly { id: string; source: string; target: string }[],
  layout: Record<string, { x: number; y: number }>,
  topology: ReturnType<typeof flowTopology>,
  runState: RunState | undefined,
  nodeInlineActions: Record<string, { approve: () => void; reject: () => void }> | undefined,
): { nodes: Node[]; edges: Edge[] } {
  const ids = registry.allIds()
  const animate = animatedEdgesFromState(runState)

  const nodes: Node[] = ids.map((id) => {
    const rec = runState?.nodes[id]
    const inputDef = registry.getInput(id)
    const kind: WorkflowNodeData["kind"] = inputDef ? "input" : "atom"
    const deferred = Boolean(inputDef?.kind === "deferred_input")
    const data: WorkflowNodeData = {
      label: id,
      kind,
      deferred,
      status: rec?.status ?? "not_reached",
      detail: statusDetail(rec),
      handles: dagHandleSides(id, topology),
    }
    const actions = nodeInlineActions?.[id]
    if (actions) data.inlineActions = actions
    return {
      id,
      type: "workflow",
      position: layout[id] ?? { x: 0, y: 0 },
      data,
    }
  })

  const edges: Edge[] = graphEdges.map((e) => ({
    ...e,
    animated: animate.has(e.id),
  }))

  return { nodes, edges }
}

function FlowInner({
  runState,
  registry,
  nodeInlineActions,
}: {
  runState: RunState | undefined
  registry: Registry
  nodeInlineActions?: Record<string, { approve: () => void; reject: () => void }>
}) {
  const [legendOpen, setLegendOpen] = useState(false)
  const prevEdgeSigRef = useRef<string | null>(null)

  const graphEdges = useMemo(
    () => edgesFromObservedDeps(registry, runState),
    [registry, runState],
  )

  const edgeSig = useMemo(
    () => graphEdges.map((e) => e.id).sort().join("|"),
    [graphEdges],
  )

  const cmp = useMemo(() => compareIdsByRegistry(registry), [registry])
  const layout = useMemo(
    () => computeWorkflowLayout(registry.allIds(), graphEdges, cmp),
    [registry, graphEdges, cmp],
  )
  const topology = useMemo(
    () => flowTopology(registry.allIds(), graphEdges),
    [registry, graphEdges],
  )

  const { nodes: nextNodes, edges: nextEdges } = useMemo(
    () =>
      buildFlow(
        registry,
        graphEdges,
        layout,
        topology,
        runState,
        nodeInlineActions,
      ),
    [registry, graphEdges, layout, topology, runState, nodeInlineActions],
  )

  const [nodes, setNodes, onNodesChange] = useNodesState(nextNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(nextEdges)

  useEffect(() => {
    const isFirst = prevEdgeSigRef.current === null
    const edgesChanged = !isFirst && prevEdgeSigRef.current !== edgeSig
    prevEdgeSigRef.current = edgeSig

    setNodes((current) => {
      if (isFirst || edgesChanged) return nextNodes
      return nextNodes.map((fresh) => {
        const existing = current.find((c) => c.id === fresh.id)
        return existing ? { ...fresh, position: existing.position } : fresh
      })
    })
    setEdges(nextEdges)
  }, [nextNodes, nextEdges, edgeSig, setNodes, setEdges])

  return (
    <Canvas
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
        Observed deps (from runtime) · drag to pan · scroll to zoom
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
                    <div className="font-medium text-foreground">{row.label}</div>
                    <div className="text-[11px] text-muted-foreground leading-snug">
                      {row.hint}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="nodrag nopan shadow-md"
          onClick={() => setLegendOpen((o) => !o)}
        >
          {legendOpen ? "Hide status key" : "Status colors"}
        </Button>
      </Panel>
    </Canvas>
  )
}

export type QueueVisualizerProps = {
  runState: RunState | undefined
  /** Registry for node list and input vs atom (after importing your workflow module). */
  registry: Registry
  /** Optional: inline actions on a node (e.g. approve/reject on a deferred input). */
  nodeInlineActions?: Record<string, { approve: () => void; reject: () => void }>
  className?: string
}

export function QueueVisualizer({
  runState,
  registry,
  nodeInlineActions,
  className,
}: QueueVisualizerProps) {
  return (
    <div
      className={cn(
        "h-full min-h-0 w-full min-w-0 bg-sidebar",
        className,
      )}
    >
      <ReactFlowProvider>
        <FlowInner
          runState={runState}
          registry={registry}
          nodeInlineActions={nodeInlineActions}
        />
      </ReactFlowProvider>
    </div>
  )
}
