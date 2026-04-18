import { useCallback, useEffect, useMemo, useState } from "react"
import { useMutation } from "@tanstack/react-query"
import { Registry as RegistryClass } from "@rxwf/core"
import type { QueueEvent, Registry, RunState } from "@rxwf/core"
import type { ZodTypeAny } from "zod"
import { AlertTriangle, Check, History } from "lucide-react"

import { Button } from "@/components/ui/button"
import { SidebarProvider, SidebarInset, SidebarTrigger } from "@/components/ui/sidebar"
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
import { WorkflowSidebar } from "@/components/workflow-sidebar"
import { defaultForSchema } from "@/components/zod-schema-form"
import { processWorkflow, fetchRunState } from "@/lib/api"
import {
  initWorkflows,
  getWorkflowEntry,
  type WorkflowEntry,
} from "@/workflows/loader"

type SidePane = null | "workflow" | "start" | "pending" | "state"

function buildInitialInputValues(registry: Registry): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  for (const input of registry.allInputs()) {
    values[input.id] = defaultForSchema(input.schema as ZodTypeAny)
  }
  return values
}

function firstSeedInputId(registry: Registry): string {
  const immediateInputs = registry.allInputs().filter((input) => input.kind === "input")
  return immediateInputs[0]?.id ?? ""
}

function findDeferredWait(
  state: RunState | undefined,
): { stepId: string; inputId: string } | undefined {
  if (!state?.nodes) return undefined
  for (const [stepId, node] of Object.entries(state.nodes)) {
    if (node.status === "waiting" && node.waitingOn) {
      return { stepId, inputId: node.waitingOn }
    }
  }
  return undefined
}

function immediateInputNeedsForm(
  registry: Registry,
  nodeId: string | null,
  runState: RunState | undefined,
): boolean {
  if (!nodeId) return false
  const input = registry.getInput(nodeId)
  if (!input || input.kind !== "input") return false
  return !runState || !runState.nodes[nodeId]
}

function deferredInputNeedsForm(
  registry: Registry,
  runState: RunState | undefined,
  nodeId: string | null,
): boolean {
  if (!nodeId || !runState) return false
  const input = registry.getInput(nodeId)
  if (!input || input.kind !== "deferred_input") return false
  if (runState.nodes[nodeId]?.status === "resolved") return false
  return deferredInputRequested(registry, runState, nodeId)
}

function isRunComplete(runState: RunState | undefined): boolean {
  if (!runState) return false
  if (Object.keys(runState.nodes).length === 0) return false
  if (findDeferredWait(runState)) return false
  for (const node of Object.values(runState.nodes)) {
    if (node.status === "waiting" || node.status === "blocked") return false
    if (node.status === "errored") return false
  }
  return true
}

async function runPreviewToIdle(
  entry: WorkflowEntry,
  seed: QueueEvent,
  state?: RunState,
): Promise<RunState> {
  const queue = [seed]
  let current = state
  while (queue.length > 0) {
    const event = queue.shift()
    if (!event) break
    const result = await entry.runtime.process(event, current)
    current = result.state
    queue.push(...result.emitted)
  }
  return current!
}

function deriveLoadingNodeIds(
  nextState: RunState,
  previousState: RunState | undefined,
  inputId: string,
): string[] {
  if (!previousState) {
    return Array.from(new Set([inputId, ...Object.keys(nextState.nodes)]))
  }
  const loadingIds = new Set<string>([inputId])
  for (const nodeId of Object.keys(nextState.nodes)) {
    const before = previousState.nodes[nodeId]
    const after = nextState.nodes[nodeId]
    if (!before || JSON.stringify(before) !== JSON.stringify(after)) {
      loadingIds.add(nodeId)
    }
  }
  return [...loadingIds]
}

export default function App() {
  const [ready, setReady] = useState(false)
  const [pane, setPane] = useState<SidePane>(null)
  const [activeFile, setActiveFile] = useState<string | null>(null)

  // Per-workflow client-side state
  const [stateMap, setStateMap] = useState<Record<string, RunState | null>>({})
  const [inputValuesMap, setInputValuesMap] = useState<Record<string, Record<string, unknown>>>({})
  const [seedInputIdMap, setSeedInputIdMap] = useState<Record<string, string>>({})

  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const [viewingHistoric, setViewingHistoric] = useState(false)
  const [payloadError, setPayloadError] = useState("")
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [predictedLoadingNodeIds, setPredictedLoadingNodeIds] = useState<string[]>([])

  // Load all workflow registries on mount
  useEffect(() => {
    initWorkflows().then(() => setReady(true))
  }, [])

  const entry = activeFile ? getWorkflowEntry(activeFile) : undefined
  const registry = entry?.registry
  const runState = activeFile ? (stateMap[activeFile] ?? undefined) : undefined

  // Initialize input values for a workflow on first select
  const ensureWorkflowState = useCallback((filename: string) => {
    const e = getWorkflowEntry(filename)
    if (!e) return
    setInputValuesMap((prev) => {
      if (prev[filename]) return prev
      return { ...prev, [filename]: buildInitialInputValues(e.registry) }
    })
    setSeedInputIdMap((prev) => {
      if (prev[filename]) return prev
      return { ...prev, [filename]: firstSeedInputId(e.registry) }
    })
  }, [])

  const inputValues = activeFile ? (inputValuesMap[activeFile] ?? {}) : {}
  const seedInputId = activeFile ? (seedInputIdMap[activeFile] ?? "") : ""

  const submitMutation = useMutation({
    mutationFn: ({
      filename,
      runState: rs,
      inputId,
      payload,
    }: {
      filename: string
      runState: RunState | null
      inputId: string
      payload: unknown
    }) => processWorkflow(filename, { runState: rs, inputId, payload }),
  })

  const wait = findDeferredWait(runState)
  const pendingDeferredId = wait?.inputId
  const inputPending = Boolean(pendingDeferredId)
  const nodes = runState?.nodes ?? {}
  const runComplete = isRunComplete(runState)
  const pendingRequest = submitMutation.isPending
  const loadingNodeIds = submitMutation.isPending ? predictedLoadingNodeIds : []

  useEffect(() => {
    if (!selectedNodeId) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedNodeId(null)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [selectedNodeId])

  useEffect(() => {
    if (!pane) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPane(null)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [pane])

  useEffect(() => {
    if (!submitMutation.isPending) {
      setPredictedLoadingNodeIds([])
    }
  }, [submitMutation.isPending])

  function setInputValue(id: string, value: unknown) {
    if (!activeFile) return
    setInputValuesMap((prev) => ({
      ...prev,
      [activeFile]: { ...(prev[activeFile] ?? {}), [id]: value },
    }))
  }

  function handleFileSelect(filename: string) {
    setActiveFile(filename)
    setActiveRunId(null)
    setViewingHistoric(false)
    setSelectedNodeId(null)
    setPayloadError("")
    setPredictedLoadingNodeIds([])
    ensureWorkflowState(filename)
    setPane(null)
  }

  async function handleRunSelect(filename: string, runId: string) {
    setActiveFile(filename)
    setSelectedNodeId(null)
    setPayloadError("")
    setPredictedLoadingNodeIds([])
    setPane(null)
    ensureWorkflowState(filename)
    try {
      const result = await fetchRunState(filename, runId)
      setStateMap((prev) => ({ ...prev, [filename]: result.runState as RunState }))
      setActiveRunId(runId)
      setViewingHistoric(true)
    } catch {
      setPayloadError("Failed to load run.")
    }
  }

  function clearRun() {
    if (!activeFile || !entry) return
    setStateMap((prev) => ({ ...prev, [activeFile]: null }))
    setInputValuesMap((prev) => ({
      ...prev,
      [activeFile]: buildInitialInputValues(entry.registry),
    }))
    setSeedInputIdMap((prev) => ({
      ...prev,
      [activeFile]: firstSeedInputId(entry.registry),
    }))
    setActiveRunId(null)
    setViewingHistoric(false)
    setSelectedNodeId(null)
    setPayloadError("")
    setPane(null)
  }

  async function submitInput(inputId: string) {
    if (!activeFile || !entry || !registry || submitMutation.isPending) return

    setPayloadError("")

    const inputDef = registry.getInput(inputId)
    if (!inputDef) {
      setPayloadError(`Input "${inputId}" not found in this workflow.`)
      return
    }

    let payload: unknown
    try {
      payload = inputDef.schema.parse(inputValues[inputId])
    } catch (error) {
      setPayloadError(
        error instanceof Error ? error.message : "Validation failed.",
      )
      return
    }

    try {
      setPane(null)

      // Client-side preview for loading indicators
      const previewState = await runPreviewToIdle(
        entry,
        {
          kind: "input",
          eventId: "preview",
          runId: runState?.runId ?? "run-1",
          inputId,
          payload,
        },
        runState,
      )
      setPredictedLoadingNodeIds(
        deriveLoadingNodeIds(previewState, runState, inputId),
      )

      // Send to stateless server
      const result = await submitMutation.mutateAsync({
        filename: activeFile,
        runState: runState ?? null,
        inputId,
        payload,
      })

      setStateMap((prev) => ({ ...prev, [activeFile]: result.runState as RunState }))
      setActiveRunId(result.runState.runId!)
      setViewingHistoric(false)

      // Sync input values from server state
      if (result.runState.inputs) {
        setInputValuesMap((prev) => ({
          ...prev,
          [activeFile]: { ...(prev[activeFile] ?? {}), ...result.runState.inputs },
        }))
      }
    } catch (error) {
      setPayloadError(
        error instanceof Error ? error.message : "Processing failed.",
      )
    }
  }

  async function runWorkflow(seedOverride?: string) {
    const inputId = seedOverride ?? seedInputId
    if (!inputId) {
      setPayloadError("No initial input is registered for this workflow.")
      return
    }
    await submitInput(inputId)
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
    await submitInput(inputId)
  }

  const selectedRecord = selectedNodeId ? nodes[selectedNodeId] : undefined

  let nodeEditor: NodeDetailEditor | null = null
  if (selectedNodeId && registry && !viewingHistoric) {
    const input = registry.getInput(selectedNodeId)

    if (input && immediateInputNeedsForm(registry, selectedNodeId, runState)) {
      nodeEditor = {
        inputDescription: input.description,
        description:
          "Submit this payload as the seed input event (same as Start Workflow).",
        schema: input.schema as ZodTypeAny,
        value: inputValues[selectedNodeId],
        onChange: (value) => setInputValue(selectedNodeId, value),
        onSubmit: () => void runWorkflow(selectedNodeId),
        submitLabel: `Submit "${selectedNodeId}"`,
        error: payloadError || undefined,
        submitting:
          submitMutation.isPending &&
          submitMutation.variables?.inputId === selectedNodeId,
      }
    } else if (input && deferredInputNeedsForm(registry, runState, selectedNodeId)) {
      const inputId = selectedNodeId
      nodeEditor = {
        inputDescription: input.description,
        description:
          "Deferred input: delivered as a separate queue event when this step is waiting (SPEC: WaitError).",
        schema: input.schema as ZodTypeAny,
        value: inputValues[inputId],
        onChange: (value) => setInputValue(inputId, value),
        onSubmit: () => void submitDeferredInput(inputId),
        submitLabel: `Submit "${inputId}"`,
        error: payloadError || undefined,
        submitting:
          submitMutation.isPending &&
          submitMutation.variables?.inputId === inputId,
      }
    }
  }

  const showEmptyOverlay = !runState && !submitMutation.isPending

  // Use a stable empty registry before workflows load
  const emptyRegistry = useMemo(() => new RegistryClass(), [])

  const displayRegistry = registry ?? emptyRegistry

  if (!ready) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <p className="text-muted-foreground text-sm">Loading workflows…</p>
      </div>
    )
  }

  return (
    <SidebarProvider>
      <WorkflowSidebar
        activeFile={activeFile}
        activeRunId={activeRunId}
        onFileSelect={handleFileSelect}
        onRunSelect={handleRunSelect}
      />

      <SidebarInset className="flex h-screen min-h-0 flex-col">
        <header className="flex min-h-10 flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
          <div className="flex items-center gap-2">
            <SidebarTrigger />
            <h1 className="min-w-0 text-sm font-semibold tracking-tight md:text-base">
              {activeFile ? activeFile.replace(/\.ts$/, "") : "Workflow"}
            </h1>
          </div>
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
            {runState && (
              <Button
                size="sm"
                variant="outline"
                onClick={clearRun}
                disabled={pendingRequest}
              >
                Clear
              </Button>
            )}
            {activeFile && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setPane("workflow")}
                aria-expanded={pane === "workflow"}
              >
                Workflow code
              </Button>
            )}
            {activeFile && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setPane("state")}
                aria-expanded={pane === "state"}
                title="Full run state including every node record"
              >
                Run state
              </Button>
            )}
            {viewingHistoric && (
              <div
                role="status"
                aria-label="Historic run"
                className="inline-flex h-7 cursor-default items-center gap-1.5 rounded-lg border border-blue-500/45 bg-blue-500/12 px-2.5 text-[0.8rem] font-medium text-blue-900 dark:border-blue-400/40 dark:bg-blue-400/14 dark:text-blue-50"
              >
                <History className="size-3.5 shrink-0" aria-hidden />
                Historic run
              </div>
            )}
            {runComplete && !viewingHistoric ? (
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
          {activeFile && (
            <QueueVisualizer
              runState={runState}
              registry={displayRegistry}
              loadingNodeIds={loadingNodeIds}
              onNodeClick={(nodeId) => setSelectedNodeId(nodeId)}
            />
          )}

          {showEmptyOverlay && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-6">
              <div className="pointer-events-auto flex max-w-md flex-col items-center gap-5 rounded-xl border border-border bg-card/95 p-8 text-center shadow-lg backdrop-blur-sm">
                {!activeFile ? (
                  <p className="text-muted-foreground text-sm leading-relaxed">
                    Select a workflow from the sidebar to get started.
                  </p>
                ) : (
                  <>
                    <p className="text-muted-foreground text-sm leading-relaxed">
                      No run yet. Review the workflow source, preview your input, then start.
                    </p>
                    <Button type="button" onClick={() => setPane("start")}>
                      Start Workflow
                    </Button>
                  </>
                )}
              </div>
            </div>
          )}

          <WorkflowCodeSheet
            open={pane === "workflow"}
            onOpenChange={(open) => setPane(open ? "workflow" : null)}
            filename={activeFile}
            onPreviewInput={() => setPane("start")}
          />

          <RunStateJsonSheet
            open={pane === "state"}
            onOpenChange={(open) => setPane(open ? "state" : null)}
            runState={runState}
          />

          {registry && (
            <StartWorkflowSheet
              open={pane === "start"}
              onOpenChange={(open) => setPane(open ? "start" : null)}
              registry={registry}
              inputValues={inputValues}
              onInputValuesChange={setInputValue}
              seedInputId={seedInputId}
              onSeedInputIdChange={(id) => {
                if (!activeFile) return
                setSeedInputIdMap((prev) => ({ ...prev, [activeFile]: id }))
              }}
              canSubmitSeed={!runState}
              submitting={
                submitMutation.isPending &&
                submitMutation.variables?.inputId === seedInputId
              }
              onSubmitSeed={() => void runWorkflow()}
              error={pane === "start" ? payloadError || undefined : undefined}
            />
          )}

          {registry && (
            <PendingInputSheet
              open={pane === "pending" && Boolean(pendingDeferredId)}
              onOpenChange={(open) => setPane(open ? "pending" : null)}
              registry={registry}
              pendingInputId={pendingDeferredId}
              inputValues={inputValues}
              onInputValuesChange={setInputValue}
              submitting={
                submitMutation.isPending &&
                submitMutation.variables?.inputId === pendingDeferredId
              }
              onSubmit={() => void submitDeferredInput()}
              error={pane === "pending" ? payloadError || undefined : undefined}
            />
          )}

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
      </SidebarInset>
    </SidebarProvider>
  )
}
