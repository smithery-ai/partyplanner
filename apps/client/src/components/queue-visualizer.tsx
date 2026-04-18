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
import { useEffect, useMemo, useState } from "react"

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
import type { NodeRecord, NodeStatus, RunState } from "@rxwf/core"
import { cn } from "@/lib/utils"

/** Matches `src/workflow.ts` — inputs and atom `name`s registered on the global registry */
export const WORKFLOW_NODE_IDS = [
  "provider",
  "assess",
  "dcrProxy",
  "oauthCreds",
  "oauthProxy",
  "buildSpec",
  "overlayReview",
  "applyOverlay",
  "deployTest",
  "scanTools",
  "deployProd",
  "prodApproval",
] as const

export type WorkflowNodeId = (typeof WORKFLOW_NODE_IDS)[number]

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
  /** When blocked on deferred overlay review, actions live on the overlay node */
  overlayReviewActions?: { approve: () => void; reject: () => void }
}

function statusVisual(data: WorkflowNodeData): StatusVisual {
  if (
    data.overlayReviewActions &&
    data.label === "overlayReview"
  )
    return "needs_input"
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

function workflowHandles(label: WorkflowNodeData["label"]): {
  target: boolean
  source: boolean
} {
  if (
    label === "provider" ||
    label === "oauthCreds" ||
    label === "overlayReview" ||
    label === "prodApproval"
  ) {
    return { target: false, source: true }
  }
  if (label === "deployProd") {
    return { target: true, source: false }
  }
  return { target: true, source: true }
}

function WorkflowNode({
  data,
}: {
  data: WorkflowNodeData
}) {
  const handles = workflowHandles(data.label)

  const pendingOverlay =
    Boolean(data.overlayReviewActions) && data.label === "overlayReview"

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
          {pendingOverlay ? (
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
      {pendingOverlay && data.overlayReviewActions && (
        <>
          <NodeContent className="space-y-1.5 p-2! pt-0 text-[11px] leading-snug text-muted-foreground">
            <p>
              <span className="font-medium text-foreground">Blocked</span> —{" "}
              applyOverlay is waiting on this input.
            </p>
          </NodeContent>
          <NodeFooter className="flex flex-col gap-1.5 p-2!">
            <Button
              type="button"
              size="sm"
              className="nodrag nopan h-7 w-full text-xs"
              onClick={() => data.overlayReviewActions?.approve()}
            >
              Approve
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="nodrag nopan h-7 w-full text-xs"
              onClick={() => data.overlayReviewActions?.reject()}
            >
              Reject
            </Button>
          </NodeFooter>
        </>
      )}
      {!pendingOverlay && data.detail && (
        <NodeContent className="break-words pt-0 text-[11px] leading-snug text-muted-foreground p-2!">
          {data.detail}
        </NodeContent>
      )}
    </WorkflowCard>
  )
}

const LAYOUT: Record<string, { x: number; y: number }> = {
  provider: { x: 0, y: 260 },
  assess: { x: 220, y: 260 },
  dcrProxy: { x: 460, y: 80 },
  oauthCreds: { x: 460, y: 0 },
  oauthProxy: { x: 460, y: 180 },
  buildSpec: { x: 460, y: 380 },
  overlayReview: { x: 680, y: 220 },
  applyOverlay: { x: 680, y: 380 },
  deployTest: { x: 900, y: 380 },
  scanTools: { x: 1120, y: 380 },
  deployProd: { x: 1340, y: 260 },
  prodApproval: { x: 1340, y: 40 },
}

const BASE_EDGES: Omit<Edge, "animated">[] = [
  { id: "provider-assess", source: "provider", target: "assess" },
  { id: "assess-dcrProxy", source: "assess", target: "dcrProxy" },
  { id: "assess-oauthProxy", source: "assess", target: "oauthProxy" },
  { id: "assess-buildSpec", source: "assess", target: "buildSpec" },
  { id: "oauthCreds-oauthProxy", source: "oauthCreds", target: "oauthProxy" },
  { id: "buildSpec-applyOverlay", source: "buildSpec", target: "applyOverlay" },
  { id: "overlayReview-applyOverlay", source: "overlayReview", target: "applyOverlay" },
  { id: "applyOverlay-deployTest", source: "applyOverlay", target: "deployTest" },
  { id: "deployTest-scanTools", source: "deployTest", target: "scanTools" },
  { id: "dcrProxy-deployProd", source: "dcrProxy", target: "deployProd" },
  { id: "oauthProxy-deployProd", source: "oauthProxy", target: "deployProd" },
  { id: "scanTools-deployProd", source: "scanTools", target: "deployProd" },
  { id: "prodApproval-deployProd", source: "prodApproval", target: "deployProd" },
]

function statusDetail(
  rec: NodeRecord | undefined,
  stepId: string,
): string | undefined {
  if (!rec) return undefined
  if (rec.status === "waiting" && rec.waitingOn) {
    if (stepId === "deployProd" && rec.waitingOn === "prodApproval") {
      return undefined
    }
    if (stepId === "applyOverlay" && rec.waitingOn === "overlayReview") {
      return undefined
    }
    if (stepId === "oauthProxy" && rec.waitingOn === "oauthCreds") {
      return undefined
    }
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

function animatedEdgeIds(state: RunState | undefined): Set<string> {
  if (!state) return new Set()
  const n = state.nodes
  if (n.deployProd?.status === "waiting" && n.deployProd.waitingOn === "prodApproval") {
    return new Set(["prodApproval-deployProd"])
  }
  if (
    n.applyOverlay?.status === "waiting" &&
    n.applyOverlay.waitingOn === "overlayReview"
  ) {
    return new Set(["overlayReview-applyOverlay"])
  }
  if (n.oauthProxy?.status === "waiting" && n.oauthProxy.waitingOn === "oauthCreds") {
    return new Set(["oauthCreds-oauthProxy"])
  }
  const assess = n.assess
  if (assess?.status === "resolved" && n.dcrProxy?.status !== "resolved" && assess.value === "dcr-proxy") {
    return new Set(["assess-dcrProxy"])
  }
  if (assess?.status === "resolved" && n.oauthProxy?.status !== "resolved" && assess.value === "oauth-proxy") {
    return new Set(["assess-oauthProxy"])
  }
  if (
    assess?.status === "resolved" &&
    n.buildSpec?.status !== "resolved" &&
    assess.value === "dispatch-worker"
  ) {
    return new Set(["assess-buildSpec"])
  }
  if (n.provider?.status === "resolved" && assess?.status !== "resolved") {
    return new Set(["provider-assess"])
  }
  if (
    n.dcrProxy?.status === "resolved" &&
    n.deployProd?.status !== "resolved" &&
    n.deployProd?.status !== "skipped"
  ) {
    return new Set(["dcrProxy-deployProd"])
  }
  if (
    n.oauthProxy?.status === "resolved" &&
    n.deployProd?.status !== "resolved" &&
    n.deployProd?.status !== "skipped"
  ) {
    return new Set(["oauthProxy-deployProd"])
  }
  if (
    n.scanTools?.status === "resolved" &&
    n.deployProd?.status !== "resolved" &&
    n.deployProd?.status !== "skipped"
  ) {
    return new Set(["scanTools-deployProd"])
  }
  return new Set()
}

function isDeferredInputId(id: string): boolean {
  return id === "oauthCreds" || id === "overlayReview" || id === "prodApproval"
}

function buildFlow(
  runState: RunState | undefined,
  overlayReviewActions?: { approve: () => void; reject: () => void },
): { nodes: Node[]; edges: Edge[] } {
  const ids = WORKFLOW_NODE_IDS
  const animate = animatedEdgeIds(runState)
  const blockedOnOverlay =
    runState?.nodes.applyOverlay?.status === "waiting" &&
    runState?.nodes.applyOverlay?.waitingOn === "overlayReview"

  const nodes: Node[] = ids.map((id) => {
    const rec = runState?.nodes[id]
    const kind: WorkflowNodeData["kind"] =
      id === "provider" || isDeferredInputId(id) ? "input" : "atom"
    const data: WorkflowNodeData = {
      label: id,
      kind,
      deferred: isDeferredInputId(id),
      status: rec?.status ?? "not_reached",
      detail: statusDetail(rec, id),
    }
    if (id === "overlayReview" && blockedOnOverlay && overlayReviewActions) {
      data.overlayReviewActions = overlayReviewActions
    }
    return {
      id,
      type: "workflow",
      position: LAYOUT[id] ?? { x: 0, y: 0 },
      data,
    }
  })

  const edges: Edge[] = BASE_EDGES.map((e) => ({
    ...e,
    animated: animate.has(e.id),
  }))

  return { nodes, edges }
}

function FlowInner({
  runState,
  overlayReviewActions,
}: {
  runState: RunState | undefined
  overlayReviewActions?: { approve: () => void; reject: () => void }
}) {
  const [legendOpen, setLegendOpen] = useState(false)

  const { nodes: nextNodes, edges: nextEdges } = useMemo(
    () => buildFlow(runState, overlayReviewActions),
    [runState, overlayReviewActions],
  )

  const [nodes, setNodes, onNodesChange] = useNodesState(nextNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(nextEdges)

  useEffect(() => {
    setNodes((current) =>
      nextNodes.map((fresh) => {
        const existing = current.find((c) => c.id === fresh.id)
        return existing
          ? { ...fresh, position: existing.position }
          : fresh
      }),
    )
    setEdges(nextEdges)
  }, [nextNodes, nextEdges, setNodes, setEdges])

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
        Graph mirrors{" "}
        <code className="rounded bg-muted px-1 py-0.5 text-[11px]">workflow.ts</code>
        · drag to pan · scroll to zoom
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

export function QueueVisualizer({
  runState,
  className,
  overlayReviewActions,
}: {
  runState: RunState | undefined
  className?: string
  /** Shown on overlayReview while applyOverlay waits on it */
  overlayReviewActions?: { approve: () => void; reject: () => void }
}) {
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
          overlayReviewActions={overlayReviewActions}
        />
      </ReactFlowProvider>
    </div>
  )
}
