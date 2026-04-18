import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
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
import {
  loadWorkflowSession,
  resetWorkflowSession,
  submitWorkflowInput,
} from "@/lib/api"

import workflowRaw from "./workflow.ts?raw"

import "./workflow"

type SidePane = null | "workflow" | "start" | "pending" | "state"

const previewRuntime = createRuntime()

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
  nodeId: string | null,
  runState: RunState | undefined,
): boolean {
  if (!nodeId) return false

  const input = globalRegistry.getInput(nodeId)
  if (!input || input.kind !== "input") return false

  return !runState || !runState.nodes[nodeId]
}

function deferredInputNeedsForm(
  runState: RunState | undefined,
  nodeId: string | null,
): boolean {
  if (!nodeId || !runState) return false

  const input = globalRegistry.getInput(nodeId)
  if (!input || input.kind !== "deferred_input") return false
  if (runState.nodes[nodeId]?.status === "resolved") return false

  return deferredInputRequested(globalRegistry, runState, nodeId)
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
  seed: QueueEvent,
  state?: RunState,
): Promise<RunState> {
  const queue = [seed]
  let current = state

  while (queue.length > 0) {
    const event = queue.shift()
    if (!event) break

    const result = await previewRuntime.process(event, current)
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
  const nextNodeIds = new Set(Object.keys(nextState.nodes))

  for (const nodeId of nextNodeIds) {
    const before = previousState.nodes[nodeId]
    const after = nextState.nodes[nodeId]

    if (!before || JSON.stringify(before) !== JSON.stringify(after)) {
      loadingIds.add(nodeId)
    }
  }

  return [...loadingIds]
}

export default function App() {
  const queryClient = useQueryClient()

  const [pane, setPane] = useState<SidePane>(null)
  const [workflowCode, setWorkflowCode] = useState(workflowRaw)
  const [inputValues, setInputValues] = useState<Record<string, unknown>>(() =>
    buildInitialInputValues(globalRegistry),
  )
  const [seedInputId, setSeedInputId] = useState(() =>
    firstSeedInputId(globalRegistry),
  )
  const [payloadError, setPayloadError] = useState("")
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [predictedLoadingNodeIds, setPredictedLoadingNodeIds] = useState<string[]>([])

  const sessionQuery = useQuery({
    queryKey: ["workflow-session"],
    queryFn: loadWorkflowSession,
  })

  const submitInputMutation = useMutation({
    mutationFn: submitWorkflowInput,
  })

  const resetSessionMutation = useMutation({
    mutationFn: resetWorkflowSession,
  })

  const runState = sessionQuery.data?.runState ?? undefined
  const wait = findDeferredWait(runState)
  const pendingDeferredId = wait?.inputId
  const inputPending = Boolean(pendingDeferredId)
  const nodes = runState?.nodes ?? {}
  const runComplete = isRunComplete(runState)
  const pendingRequest =
    submitInputMutation.isPending || resetSessionMutation.isPending
  const loadingNodeIds = submitInputMutation.isPending ? predictedLoadingNodeIds : []

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
    const inputs = sessionQuery.data?.runState?.inputs
    if (!inputs) return

    setInputValues((previous) => ({ ...previous, ...inputs }))
  }, [sessionQuery.data?.runState?.inputs])

  useEffect(() => {
    if (!submitInputMutation.isPending) {
      setPredictedLoadingNodeIds([])
    }
  }, [submitInputMutation.isPending])

  function setInputValue(id: string, value: unknown) {
    setInputValues((previous) => ({ ...previous, [id]: value }))
  }

  async function clearRun() {
    if (pendingRequest) return

    setPayloadError("")
    setSelectedNodeId(null)
    setPane(null)

    try {
      const session = await resetSessionMutation.mutateAsync()
      queryClient.setQueryData(["workflow-session"], session)
      setInputValues(buildInitialInputValues(globalRegistry))
      setSeedInputId(firstSeedInputId(globalRegistry))
    } catch (error) {
      setPayloadError(
        error instanceof Error ? error.message : "Reset failed — refresh and try again.",
      )
    }
  }

  async function runWorkflow(seedOverride?: string) {
    if (submitInputMutation.isPending) return

    setPayloadError("")

    const inputId = seedOverride ?? seedInputId
    const seed = globalRegistry.getInput(inputId)
    if (!seed || seed.kind !== "input") {
      setPayloadError("No initial input is registered for this workflow.")
      return
    }

    let payload: unknown
    try {
      payload = seed.schema.parse(inputValues[seed.id])
    } catch (error) {
      setPayloadError(
        error instanceof Error ? error.message : "Validation failed for the initial input.",
      )
      return
    }

    try {
      setPane(null)
      const previewState = await runPreviewToIdle(
        {
          kind: "input",
          eventId: "preview-seed",
          runId: sessionQuery.data?.runId ?? "run-1",
          inputId: seed.id,
          payload,
        },
        runState,
      )
      setPredictedLoadingNodeIds(
        deriveLoadingNodeIds(previewState, runState, seed.id),
      )
      const session = await submitInputMutation.mutateAsync({
        inputId: seed.id,
        payload,
      })

      queryClient.setQueryData(["workflow-session"], session)
    } catch (error) {
      setPayloadError(
        error instanceof Error ? error.message : "Processing failed — check input values.",
      )
    }
  }

  async function submitDeferredInput(explicitInputId?: string) {
    if (submitInputMutation.isPending) return

    const inputId = explicitInputId ?? pendingDeferredId
    if (!inputId) return
    if (inputId !== pendingDeferredId) {
      setPayloadError(
        `This run is waiting on "${pendingDeferredId ?? "—"}", not "${inputId}".`,
      )
      return
    }

    const deferredInput = globalRegistry.getInput(inputId)
    if (!deferredInput) return

    setPayloadError("")

    let payload: unknown
    try {
      payload = deferredInput.schema.parse(inputValues[inputId])
    } catch (error) {
      setPayloadError(
        error instanceof Error ? error.message : `Validation failed for "${inputId}".`,
      )
      return
    }

    try {
      setPane(null)
      const previewState = await runPreviewToIdle(
        {
          kind: "input",
          eventId: "preview-deferred",
          runId: sessionQuery.data?.runId ?? runState?.runId ?? "run-1",
          inputId,
          payload,
        },
        runState,
      )
      setPredictedLoadingNodeIds(
        deriveLoadingNodeIds(previewState, runState, inputId),
      )
      const session = await submitInputMutation.mutateAsync({
        inputId,
        payload,
      })

      queryClient.setQueryData(["workflow-session"], session)
    } catch (error) {
      setPayloadError(
        error instanceof Error ? error.message : "Processing failed — check input values.",
      )
    }
  }

  const selectedRecord = selectedNodeId ? nodes[selectedNodeId] : undefined

  let nodeEditor: NodeDetailEditor | null = null
  if (selectedNodeId) {
    const input = globalRegistry.getInput(selectedNodeId)

    if (input && immediateInputNeedsForm(selectedNodeId, runState)) {
      nodeEditor = {
        inputDescription: input.description,
        description:
          "Submit this payload as the seed input event (same as Start Workflow).",
        schema: input.schema as ZodTypeAny,
        value: inputValues[selectedNodeId],
        onChange: (value) => setInputValue(selectedNodeId, value),
        onSubmit: () => void runWorkflow(selectedNodeId),
        submitLabel: `Submit “${selectedNodeId}”`,
        error: payloadError || undefined,
        submitting:
          submitInputMutation.isPending &&
          submitInputMutation.variables?.inputId === selectedNodeId,
      }
    } else if (input && deferredInputNeedsForm(runState, selectedNodeId)) {
      const inputId = selectedNodeId

      nodeEditor = {
        inputDescription: input.description,
        description:
          "Deferred input: delivered as a separate queue event when this step is waiting (SPEC: WaitError).",
        schema: input.schema as ZodTypeAny,
        value: inputValues[inputId],
        onChange: (value) => setInputValue(inputId, value),
        onSubmit: () => void submitDeferredInput(inputId),
        submitLabel: `Submit “${inputId}”`,
        error: payloadError || undefined,
        submitting:
          submitInputMutation.isPending &&
          submitInputMutation.variables?.inputId === inputId,
      }
    }
  }

  const showEmptyOverlay =
    sessionQuery.isError ||
    sessionQuery.isLoading ||
    (!runState && !submitInputMutation.isPending)

  return (
    <div className="flex h-screen min-h-0 flex-col bg-background">
      <header className="flex min-h-10 flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h1 className="min-w-0 text-sm font-semibold tracking-tight md:text-base">
          Workflow
        </h1>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
          {runState && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void clearRun()}
              disabled={pendingRequest}
            >
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
          loadingNodeIds={loadingNodeIds}
          onNodeClick={(nodeId) => setSelectedNodeId(nodeId)}
        />

        {showEmptyOverlay && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-6">
            <div className="pointer-events-auto flex max-w-md flex-col items-center gap-5 rounded-xl border border-border bg-card/95 p-8 text-center shadow-lg backdrop-blur-sm">
              {sessionQuery.isError ? (
                <p className="text-muted-foreground text-sm leading-relaxed">
                  {sessionQuery.error instanceof Error
                    ? sessionQuery.error.message
                    : "Failed to load workflow session."}
                </p>
              ) : sessionQuery.isLoading ? (
                <p className="text-muted-foreground text-sm leading-relaxed">
                  Loading workflow session...
                </p>
              ) : (
                <>
                  <p className="text-muted-foreground text-sm leading-relaxed">
                    No run yet. Review the workflow source, preview your input, then start.
                  </p>
                  <Button type="button" onClick={() => setPane("workflow")}>
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
          workflowCode={workflowCode}
          onWorkflowCodeChange={setWorkflowCode}
          onPreviewInput={() => setPane("start")}
        />

        <RunStateJsonSheet
          open={pane === "state"}
          onOpenChange={(open) => setPane(open ? "state" : null)}
          runState={runState}
        />

        <StartWorkflowSheet
          open={pane === "start"}
          onOpenChange={(open) => setPane(open ? "start" : null)}
          registry={globalRegistry}
          inputValues={inputValues}
          onInputValuesChange={setInputValue}
          seedInputId={seedInputId}
          onSeedInputIdChange={setSeedInputId}
          canSubmitSeed={!runState}
          submitting={
            submitInputMutation.isPending &&
            submitInputMutation.variables?.inputId === seedInputId
          }
          onSubmitSeed={() => void runWorkflow()}
          error={pane === "start" ? payloadError || undefined : undefined}
        />

        <PendingInputSheet
          open={pane === "pending" && Boolean(pendingDeferredId)}
          onOpenChange={(open) => setPane(open ? "pending" : null)}
          registry={globalRegistry}
          pendingInputId={pendingDeferredId}
          inputValues={inputValues}
          onInputValuesChange={setInputValue}
          submitting={
            submitInputMutation.isPending &&
            submitInputMutation.variables?.inputId === pendingDeferredId
          }
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
