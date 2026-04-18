import { useState, useRef, useEffect, useMemo } from "react"
import { createRuntime } from "@rxwf/core"
import type { QueueEvent, RunState, NodeRecord } from "@rxwf/core"
import { X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"
import { QueueVisualizer } from "@/components/queue-visualizer"

import workflowRaw from "./workflow.ts?raw"

import "./workflow"

const runtime = createRuntime()

async function runToIdle(
  seed: QueueEvent,
  state?: RunState,
): Promise<{ state: RunState; log: string[] }> {
  const queue = [seed]
  const log: string[] = []
  let current = state

  while (queue.length > 0) {
    const event = queue.shift()!
    const result = await runtime.process(event, current)
    current = result.state

    if (event.kind === "input") {
      log.push(`Processed input "${event.inputId}"`)
    } else {
      const node = result.trace.nodes[event.stepId]
      if (node) log.push(`Step "${event.stepId}" → ${node.status}`)
    }

    queue.push(...result.emitted)
  }

  return { state: current!, log }
}

/** Default seed: DCR proxy path — shortest run before prod approval */
const DEFAULT_PROVIDER_PAYLOAD = `{
  "name": "Acme MCP",
  "mcpUrl": "https://mcp.acme.dev",
  "hasDcr": true
}`

const DEFAULT_DEFERRED_TEMPLATES: Record<string, string> = {
  oauthCreds: `{
  "clientId": "example-client-id",
  "clientSecret": "example-client-secret"
}`,
  overlayReview: `{
  "approved": true,
  "strippedPaths": ["/internal"]
}`,
  prodApproval: `{
  "approved": true,
  "confirmCode": "DEPLOY-42"
}`,
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

type SidePanel = "code" | "payload" | "activity" | null

export default function App() {
  const [panel, setPanel] = useState<SidePanel>(null)
  const [workflowCode, setWorkflowCode] = useState(workflowRaw)
  const [providerJson, setProviderJson] = useState(DEFAULT_PROVIDER_PAYLOAD)
  const [deferredJson, setDeferredJson] = useState("")
  const [payloadError, setPayloadError] = useState("")

  const [runState, setRunState] = useState<RunState | undefined>()
  const [log, setLog] = useState<string[]>([])
  const [idempotencyMsg, setIdempotencyMsg] = useState("")

  const lastSeedEvent = useRef<QueueEvent | null>(null)
  const eventCounter = useRef(0)

  const wait = findDeferredWait(runState)
  const pendingDeferredId = wait?.inputId

  useEffect(() => {
    if (pendingDeferredId && DEFAULT_DEFERRED_TEMPLATES[pendingDeferredId]) {
      setDeferredJson(DEFAULT_DEFERRED_TEMPLATES[pendingDeferredId]!)
    }
  }, [pendingDeferredId])

  useEffect(() => {
    if (!panel) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPanel(null)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [panel])

  function openPanel(id: Exclude<SidePanel, null>) {
    setPanel((p) => (p === id ? null : id))
  }

  async function runProvider() {
    setPayloadError("")
    let payload: unknown
    try {
      payload = JSON.parse(providerJson) as unknown
    } catch {
      setPayloadError("Invalid JSON — fix the provider payload before running.")
      setPanel("payload")
      return
    }

    const eventId = `evt-${++eventCounter.current}`
    const event: QueueEvent = {
      kind: "input",
      eventId,
      runId: "run-1",
      inputId: "provider",
      payload,
    }
    lastSeedEvent.current = event
    setIdempotencyMsg("")

    try {
      const result = await runToIdle(event)
      setRunState(result.state)
      setLog(result.log)
    } catch (e) {
      setPayloadError(
        e instanceof Error ? e.message : "Processing failed — check payload shape.",
      )
      setPanel("payload")
    }
  }

  async function submitDeferredInput() {
    if (!pendingDeferredId) return
    setPayloadError("")
    let payload: unknown
    try {
      payload = JSON.parse(deferredJson) as unknown
    } catch {
      setPayloadError(`Invalid JSON — fix the deferred payload for "${pendingDeferredId}".`)
      setPanel("payload")
      return
    }

    const eventId = `evt-${++eventCounter.current}`
    const event: QueueEvent = {
      kind: "input",
      eventId,
      runId: "run-1",
      inputId: pendingDeferredId,
      payload,
    }

    try {
      const result = await runToIdle(event, runState)
      setRunState(result.state)
      setLog((prev) => [...prev, "", `── Deferred: ${pendingDeferredId} ──`, ...result.log])
    } catch (e) {
      setPayloadError(
        e instanceof Error ? e.message : "Processing failed — check deferred payload shape.",
      )
      setPanel("payload")
    }
  }

  async function handleOverlayReview(approved: boolean) {
    if (!runState) return
    const eventId = `evt-${++eventCounter.current}`
    const event: QueueEvent = {
      kind: "input",
      eventId,
      runId: "run-1",
      inputId: "overlayReview",
      payload: {
        approved,
        strippedPaths: approved ? [] : undefined,
      },
    }

    const result = await runToIdle(event, runState)
    setRunState(result.state)
    setLog((prev) => [...prev, "", "── Overlay review ──", ...result.log])
  }

  async function replayLastSeedEvent() {
    if (!lastSeedEvent.current || !runState) return

    const result = await runToIdle(lastSeedEvent.current, runState)

    const changed = JSON.stringify(result.state) !== JSON.stringify(runState)
    setIdempotencyMsg(
      changed
        ? "State changed (unexpected!)"
        : "No effect — event was already processed. State is identical.",
    )
    setLog((prev) => [
      ...prev,
      "",
      "── Replayed same seed event ──",
      ...result.log,
      changed ? "⚠ State changed" : "State unchanged (idempotent)",
    ])
  }

  const nodes = runState?.nodes ?? {}
  const blockedOnOverlay =
    nodes.applyOverlay?.status === "waiting" &&
    nodes.applyOverlay?.waitingOn === "overlayReview"

  const overlayReviewActions = useMemo(() => {
    if (!blockedOnOverlay) return undefined
    return {
      approve: () => void handleOverlayReview(true),
      reject: () => void handleOverlayReview(false),
    }
  }, [blockedOnOverlay, runState])

  const deployProdNode = nodes.deployProd
  const isComplete =
    deployProdNode?.status === "resolved" || deployProdNode?.status === "skipped"

  return (
    <div className="flex h-screen min-h-0 flex-col bg-background">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <h1 className="text-sm font-semibold tracking-tight md:text-base">
          Provider onboarding workflow
        </h1>
        <span className="hidden text-muted-foreground text-xs sm:inline">
          Graph follows{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-[11px]">workflow.ts</code>
          ; open panels when you need them.
        </span>
        <div className="flex-1" />
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            variant={panel === "code" ? "secondary" : "outline"}
            onClick={() => openPanel("code")}
          >
            Workflow code
          </Button>
          <Button
            size="sm"
            variant={panel === "payload" ? "secondary" : "outline"}
            onClick={() => openPanel("payload")}
          >
            Payload
            {payloadError ? (
              <span
                className="ml-1 inline-block size-1.5 rounded-full bg-destructive"
                title="Error"
              />
            ) : null}
          </Button>
          <Button
            size="sm"
            variant={panel === "activity" ? "secondary" : "outline"}
            onClick={() => openPanel("activity")}
          >
            Activity
          </Button>
          <Button size="sm" onClick={runProvider}>
            Run
          </Button>
          {pendingDeferredId && (
            <Button size="sm" variant="secondary" onClick={submitDeferredInput}>
              Submit “{pendingDeferredId}”
            </Button>
          )}
          {runState && lastSeedEvent.current && (
            <Button size="sm" variant="outline" onClick={replayLastSeedEvent}>
              Replay
            </Button>
          )}
        </div>
      </header>

      <div className="relative min-h-0 flex-1">
        <QueueVisualizer
          runState={runState}
          overlayReviewActions={overlayReviewActions}
        />

        {panel && (
          <>
            <button
              type="button"
              aria-label="Close panel"
              className="fixed inset-0 z-40 bg-background/80 backdrop-blur-sm"
              onClick={() => setPanel(null)}
            />
            <aside className="fixed inset-y-0 right-0 z-50 flex w-full max-w-lg flex-col border-l border-border bg-card shadow-xl">
              <div className="flex items-center justify-between border-b border-border px-4 py-3">
                <h2 className="font-semibold text-sm">
                  {panel === "code" && "Workflow code"}
                  {panel === "payload" && "Payloads"}
                  {panel === "activity" && "Activity"}
                </h2>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => setPanel(null)}
                  aria-label="Close"
                >
                  <X className="size-4" />
                </Button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                {panel === "code" && (
                  <div className="flex flex-col gap-3">
                    <Textarea
                      spellCheck={false}
                      value={workflowCode}
                      onChange={(e) => setWorkflowCode(e.target.value)}
                      className="min-h-[min(60vh,480px)] resize-y font-mono text-xs leading-relaxed"
                    />
                    <p className="text-muted-foreground text-[11px] leading-snug">
                      The live runtime uses the compiled{" "}
                      <code className="rounded bg-muted px-1 py-0.5">
                        workflow.ts
                      </code>{" "}
                      module; this buffer is for viewing and editing alongside the
                      run.
                    </p>
                    <a
                      className="text-muted-foreground text-[11px] underline underline-offset-2 hover:text-foreground"
                      href="https://elements.ai-sdk.dev/examples/workflow"
                      rel="noreferrer"
                      target="_blank"
                    >
                      AI Elements workflow example
                    </a>
                  </div>
                )}
                {panel === "payload" && (
                  <div className="flex flex-col gap-4">
                    <div className="flex flex-col gap-2">
                      <p className="font-medium text-foreground text-xs">
                        Initial: <code className="text-[11px]">provider</code>
                      </p>
                      <Textarea
                        spellCheck={false}
                        value={providerJson}
                        onChange={(e) => setProviderJson(e.target.value)}
                        className="min-h-[min(28vh,220px)] resize-y font-mono text-xs leading-relaxed"
                      />
                    </div>
                    {pendingDeferredId && (
                      <div className="flex flex-col gap-2 border-border border-t pt-4">
                        <p className="font-medium text-foreground text-xs">
                          Next deferred:{" "}
                          <code className="text-[11px]">{pendingDeferredId}</code>
                        </p>
                        <Textarea
                          spellCheck={false}
                          value={deferredJson}
                          onChange={(e) => setDeferredJson(e.target.value)}
                          className="min-h-[min(28vh,220px)] resize-y font-mono text-xs leading-relaxed"
                        />
                      </div>
                    )}
                    {payloadError && (
                      <p className="text-destructive text-xs">{payloadError}</p>
                    )}
                  </div>
                )}
                {panel === "activity" && (
                  <div className="flex flex-col gap-4">
                    {runState && (
                      <Card>
                        <CardHeader className="py-3">
                          <CardTitle className="text-sm">Node records</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-2 pt-0">
                          <div className="space-y-2 font-mono text-xs">
                            {Object.entries(nodes).map(([id, node]) => (
                              <NodeRow key={id} id={id} node={node} />
                            ))}
                          </div>
                        </CardContent>
                      </Card>
                    )}
                    {pendingDeferredId === "overlayReview" && blockedOnOverlay && (
                      <Card>
                        <CardHeader className="py-3">
                          <CardTitle className="text-sm">Overlay review</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-3 pt-0">
                          <p className="text-muted-foreground text-xs">
                            <code className="text-foreground">applyOverlay</code>{" "}
                            is waiting on{" "}
                            <code className="text-foreground">overlayReview</code>.
                            Use the graph or buttons below.
                          </p>
                          <div className="flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              onClick={() => handleOverlayReview(true)}
                            >
                              Approve
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => handleOverlayReview(false)}
                            >
                              Reject
                            </Button>
                          </div>
                        </CardContent>
                      </Card>
                    )}
                    {pendingDeferredId &&
                      pendingDeferredId !== "overlayReview" &&
                      !blockedOnOverlay && (
                        <Card>
                          <CardHeader className="py-3">
                            <CardTitle className="text-sm">
                              Deferred: {pendingDeferredId}
                            </CardTitle>
                          </CardHeader>
                          <CardContent className="space-y-3 pt-0">
                            <p className="text-muted-foreground text-xs">
                              Open <strong className="text-foreground">Payload</strong>{" "}
                              to edit JSON, then use{" "}
                              <strong className="text-foreground">
                                Submit “{pendingDeferredId}”
                              </strong>{" "}
                              in the header.
                            </p>
                          </CardContent>
                        </Card>
                      )}
                    {runState && lastSeedEvent.current && (
                      <Card>
                        <CardHeader className="py-3">
                          <CardTitle className="text-sm">
                            {isComplete ? "Idempotency" : "Idempotency (replay)"}
                          </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-3 pt-0">
                          <p className="text-muted-foreground text-xs">
                            Re-process the seed provider event{" "}
                            {lastSeedEvent.current.eventId}. If it is already in{" "}
                            <code className="rounded bg-muted px-1 py-0.5">
                              processedEventIds
                            </code>
                            , the runtime skips it.
                          </p>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={replayLastSeedEvent}
                          >
                            Replay {lastSeedEvent.current.eventId}
                          </Button>
                          {idempotencyMsg && (
                            <p className="text-sm font-medium">{idempotencyMsg}</p>
                          )}
                        </CardContent>
                      </Card>
                    )}
                    {log.length > 0 && (
                      <Card>
                        <CardHeader className="py-3">
                          <CardTitle className="text-sm">Event log</CardTitle>
                        </CardHeader>
                        <CardContent className="pt-0">
                          <pre className="text-muted-foreground max-h-[50vh] overflow-auto font-mono text-[11px] whitespace-pre-wrap">
                            {log.join("\n")}
                          </pre>
                        </CardContent>
                      </Card>
                    )}
                    {!runState && log.length === 0 && (
                      <p className="text-muted-foreground text-sm">
                        Run the workflow or open Payload / Workflow code to get
                        started.
                      </p>
                    )}
                  </div>
                )}
              </div>
            </aside>
          </>
        )}
      </div>
    </div>
  )
}

function NodeRow({ id, node }: { id: string; node: NodeRecord }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-28 shrink-0 text-right text-muted-foreground sm:w-32">
        {id}
      </span>
      <StatusBadge status={node.status} />
      {"value" in node && node.value !== undefined && (
        <span className="text-foreground">
          {typeof node.value === "string"
            ? node.value
            : JSON.stringify(node.value)}
        </span>
      )}
      {node.waitingOn && (
        <span className="text-muted-foreground">
          waiting on &quot;{node.waitingOn}&quot;
        </span>
      )}
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const variant =
    status === "resolved"
      ? "default"
      : status === "waiting"
        ? "secondary"
        : status === "skipped"
          ? "outline"
          : "destructive"

  return <Badge variant={variant}>{status}</Badge>
}
