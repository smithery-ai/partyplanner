import { useState, useRef, useEffect } from "react"
import { createRuntime, globalRegistry } from "@rxwf/core"
import type { QueueEvent, Registry, RunState } from "@rxwf/core"
import type { ZodTypeAny } from "zod"
import { AlertTriangle, Check } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  deferredInputRequested,
  QueueVisualizer,
} from "@/components/queue-visualizer"
import {
  NodeDetailSheet,
  type NodeDetailEditor,
} from "@/components/node-detail-sheet"
import { PendingInputSheet } from "@/components/pending-input-sheet"
import { StartWorkflowSheet } from "@/components/start-workflow-sheet"
import { RunStateJsonSheet } from "@/components/run-state-json-sheet"
import { WorkflowCodeSheet } from "@/components/workflow-code-sheet"
import { defaultForSchema } from "@/components/zod-schema-form"

import workflowRaw from "./workflow.ts?raw"

import "./workflow"

const runtime = createRuntime()

type SidePane = null | "workflow" | "start" | "pending" | "state"

function buildInitialInputValues(registry: Registry): Record<string, unknown> {
  const m: Record<string, unknown> = {}
  for (const inp of registry.allInputs()) {
    m[inp.id] = defaultForSchema(inp.schema as ZodTypeAny)
  }
  return m
}

function firstSeedInputId(registry: Registry): string {
  const im = registry.allInputs().filter((i) => i.kind === "input")
  return im[0]?.id ?? ""
}

function findDeferredWait(
  state: RunState | undefined,
): { stepId: string; inputId: string } | undefined {
  if (!state?.nodes) return undefined
  for (const [stepId, n] of Object.entries(state.nodes)) {
    if (n.status === "waiting" && n.waitingOn) {
      return { stepId, inputId: n.waitingOn }
    }
  }
  return undefined
}

function immediateInputNeedsForm(
  nodeId: string | null,
  runState: RunState | undefined,
): boolean {
  if (!nodeId) return false
  const def = globalRegistry.getInput(nodeId)
  if (!def || def.kind !== "input") return false
  return !runState || !runState.nodes[nodeId]
}

function deferredInputNeedsForm(
  runState: RunState | undefined,
  nodeId: string | null,
): boolean {
  if (!nodeId || !runState) return false
  const def = globalRegistry.getInput(nodeId)
  if (!def || def.kind !== "deferred_input") return false
  if (runState.nodes[nodeId]?.status === "resolved") return false
  return deferredInputRequested(globalRegistry, runState, nodeId)
}

function isRunComplete(runState: RunState | undefined): boolean {
  if (!runState) return false
  if (Object.keys(runState.nodes).length === 0) return false
  if (findDeferredWait(runState)) return false
  for (const n of Object.values(runState.nodes)) {
    if (n.status === "waiting" || n.status === "blocked") return false
    if (n.status === "errored") return false
  }
  return true
}

async function runToIdle(
  seed: QueueEvent,
  state?: RunState,
): Promise<{ state: RunState }> {
  const queue = [seed]
  let current = state

  while (queue.length > 0) {
    const event = queue.shift()!
    const result = await runtime.process(event, current)
    current = result.state
    queue.push(...result.emitted)
  }

  return { state: current! }
}

export default function App() {
  const [pane, setPane] = useState<SidePane>(null)
  const [workflowCode, setWorkflowCode] = useState(workflowRaw)
  const [inputValues, setInputValues] = useState<Record<string, unknown>>(() =>
    buildInitialInputValues(globalRegistry),
  )
  const [seedInputId, setSeedInputId] = useState(() =>
    firstSeedInputId(globalRegistry),
  )

  const [payloadError, setPayloadError] = useState("")
  const [runState, setRunState] = useState<RunState | undefined>()
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)

  const eventCounter = useRef(0)

  const wait = findDeferredWait(runState)
  const pendingDeferredId = wait?.inputId
  const inputPending = Boolean(pendingDeferredId)

  const nodes = runState?.nodes ?? {}
  const runComplete = isRunComplete(runState)

  useEffect(() => {
    if (!selectedNodeId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedNodeId(null)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [selectedNodeId])

  useEffect(() => {
    if (!pane) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPane(null)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [pane])

  function setInputValue(id: string, value: unknown) {
    setInputValues((prev) => ({ ...prev, [id]: value }))
  }

  function clearRun() {
    setRunState(undefined)
    setSelectedNodeId(null)
    setInputValues(buildInitialInputValues(globalRegistry))
    setSeedInputId(firstSeedInputId(globalRegistry))
    setPayloadError("")
    setPane(null)
  }

  async function runWorkflow(seedOverride?: string) {
    setPayloadError("")
    const id = seedOverride ?? seedInputId
    const seed = globalRegistry.getInput(id)
    if (!seed || seed.kind !== "input") {
      setPayloadError("No initial input is registered for this workflow.")
      return
    }
    let payload: unknown
    try {
      payload = seed.schema.parse(inputValues[seed.id])
    } catch (e) {
      setPayloadError(
        e instanceof Error ? e.message : "Validation failed for the initial input.",
      )
      return
    }

    const eventId = `evt-${++eventCounter.current}`
    const event: QueueEvent = {
      kind: "input",
      eventId,
      runId: "run-1",
      inputId: seed.id,
      payload,
    }
    try {
      const result = await runToIdle(event)
      setRunState(result.state)
      setPane(null)
    } catch (e) {
      setPayloadError(
        e instanceof Error ? e.message : "Processing failed — check input values.",
      )
    }
  }

  async function submitDeferredInput(explicitInputId?: string) {
    const inputId = explicitInputId ?? pendingDeferredId
    if (!inputId) return
    if (inputId !== pendingDeferredId) {
      setPayloadError(
        `This run is waiting on "${pendingDeferredId ?? "—"}", not "${inputId}".`,
      )
      return
    }
    const def = globalRegistry.getInput(inputId)
    if (!def) return

    setPayloadError("")
    let payload: unknown
    try {
      payload = def.schema.parse(inputValues[inputId])
    } catch (e) {
      setPayloadError(
        e instanceof Error ? e.message : `Validation failed for "${inputId}".`,
      )
      return
    }

    const eventId = `evt-${++eventCounter.current}`
    const event: QueueEvent = {
      kind: "input",
      eventId,
      runId: "run-1",
      inputId,
      payload,
    }

    try {
      const result = await runToIdle(event, runState)
      setRunState(result.state)
      setPane(null)
    } catch (e) {
      setPayloadError(
        e instanceof Error ? e.message : "Processing failed — check input values.",
      )
    }
  }

  const selectedRecord = selectedNodeId ? nodes[selectedNodeId] : undefined

  let nodeEditor: NodeDetailEditor | null = null
  if (selectedNodeId) {
    const def = globalRegistry.getInput(selectedNodeId)
    if (def && immediateInputNeedsForm(selectedNodeId, runState)) {
      nodeEditor = {
        description:
          "Submit this payload as the seed input event (same as Start Workflow).",
        schema: def.schema as ZodTypeAny,
        value: inputValues[selectedNodeId],
        onChange: (v) => setInputValue(selectedNodeId, v),
        onSubmit: () => void runWorkflow(selectedNodeId),
        submitLabel: `Submit “${selectedNodeId}”`,
        error: payloadError || undefined,
      }
    } else if (def && deferredInputNeedsForm(runState, selectedNodeId)) {
      const id = selectedNodeId
      nodeEditor = {
        description:
          "Deferred input: delivered as a separate queue event when this step is waiting (SPEC: WaitError).",
        schema: def.schema as ZodTypeAny,
        value: inputValues[id],
        onChange: (v) => setInputValue(id, v),
        onSubmit: () => void submitDeferredInput(id),
        submitLabel: `Submit “${id}”`,
        error: payloadError || undefined,
      }
    }
  }

  return (
    <div className="flex h-screen min-h-0 flex-col bg-background">
      <header className="flex min-h-10 flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h1 className="min-w-0 text-sm font-semibold tracking-tight md:text-base">
          Workflow
        </h1>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
          {runState && (
            <Button size="sm" variant="outline" onClick={clearRun}>
              Clear
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => setPane("workflow")}
            aria-expanded={pane === "workflow"}
          >
            Workflow code
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setPane("state")}
            aria-expanded={pane === "state"}
            title="Full run state including every node record"
          >
            Run state
          </Button>
          {runComplete ? (
            <div
              role="status"
              aria-label="Run complete"
              className="inline-flex h-7 cursor-default items-center gap-1.5 rounded-lg border border-emerald-600/45 bg-emerald-600/12 px-2.5 text-[0.8rem] font-medium text-emerald-900 dark:border-emerald-500/40 dark:bg-emerald-500/14 dark:text-emerald-50"
            >
              <Check className="size-3.5 shrink-0 stroke-[2.5]" aria-hidden />
              Run complete
            </div>
          ) : inputPending ? (
            <button
              type="button"
              aria-label="Open pending input"
              className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-lg border border-yellow-500/50 bg-yellow-400/15 px-2.5 text-[0.8rem] font-medium text-yellow-950 dark:border-yellow-500/45 dark:bg-yellow-500/12 dark:text-yellow-50"
              onClick={() => setPane("pending")}
            >
              <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
              Input pending
            </button>
          ) : null}
        </div>
      </header>

      <div className="relative min-h-0 flex-1">
        <QueueVisualizer
          runState={runState}
          registry={globalRegistry}
          onNodeClick={(id) => setSelectedNodeId(id)}
        />

        {!runState && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-6">
            <div className="pointer-events-auto flex max-w-md flex-col items-center gap-5 rounded-xl border border-border bg-card/95 p-8 text-center shadow-lg backdrop-blur-sm">
              <p className="text-muted-foreground text-sm leading-relaxed">
                No run yet. Open workflow source or submit a seed payload to begin.
              </p>
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button type="button" variant="secondary" onClick={() => setPane("workflow")}>
                  Workflow code
                </Button>
                <Button type="button" onClick={() => setPane("start")}>
                  Start Workflow
                </Button>
              </div>
            </div>
          </div>
        )}

        <WorkflowCodeSheet
          open={pane === "workflow"}
          onOpenChange={(o) => setPane(o ? "workflow" : null)}
          workflowCode={workflowCode}
          onWorkflowCodeChange={setWorkflowCode}
        />

        <RunStateJsonSheet
          open={pane === "state"}
          onOpenChange={(o) => setPane(o ? "state" : null)}
          runState={runState}
        />

        <StartWorkflowSheet
          open={pane === "start"}
          onOpenChange={(o) => setPane(o ? "start" : null)}
          registry={globalRegistry}
          inputValues={inputValues}
          onInputValuesChange={setInputValue}
          seedInputId={seedInputId}
          onSeedInputIdChange={setSeedInputId}
          canSubmitSeed={!runState}
          onSubmitSeed={() => void runWorkflow()}
          error={pane === "start" ? payloadError || undefined : undefined}
        />

        <PendingInputSheet
          open={pane === "pending" && Boolean(pendingDeferredId)}
          onOpenChange={(o) => setPane(o ? "pending" : null)}
          registry={globalRegistry}
          pendingInputId={pendingDeferredId}
          inputValues={inputValues}
          onInputValuesChange={setInputValue}
          onSubmit={() => void submitDeferredInput()}
          error={pane === "pending" ? payloadError || undefined : undefined}
        />

        <NodeDetailSheet
          nodeId={selectedNodeId}
          record={selectedRecord}
          editor={nodeEditor}
          open={selectedNodeId !== null}
          onOpenChange={(open) => {
            if (!open) setSelectedNodeId(null)
          }}
        />
      </div>
    </div>
  )
}
