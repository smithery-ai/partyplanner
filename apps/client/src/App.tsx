import type { Registry, RunState } from "@rxwf/core";
import { globalRegistry } from "@rxwf/core";
import type { QueueSnapshot } from "@rxwf/runtime";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  AlertTriangle,
  Check,
  Clock3,
  History,
  Pause,
  Play,
  RefreshCw,
  SkipForward,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { ZodTypeAny } from "zod";
import {
  type NodeDetailEditor,
  NodeDetailSheet,
} from "@/components/node-detail-sheet";
import { PendingInputSheet } from "@/components/pending-input-sheet";
import {
  deferredInputRequested,
  QueueVisualizer,
} from "@/components/queue-visualizer";
import { RunStateJsonSheet } from "@/components/run-state-json-sheet";
import { StartWorkflowSheet } from "@/components/start-workflow-sheet";
import { Button } from "@/components/ui/button";
import { WorkflowCodeSheet } from "@/components/workflow-code-sheet";
import { defaultForSchema } from "@/components/zod-schema-form";
import {
  useWorkflow,
  useWorkflowRun,
  useWorkflows,
} from "@/hooks/use-workflow";
import { loadWorkflowSourceIntoGlobalRegistry } from "@/lib/evaluate-workflow-source";
import { cn } from "@/lib/utils";
import type { RunSummary } from "../../backend/src/rpc";
import workflowRaw from "./workflow.ts?raw";

type SidePane = null | "workflow" | "start" | "pending" | "state";

function buildInitialInputValues(registry: Registry): Record<string, unknown> {
  const m: Record<string, unknown> = {};
  for (const inp of registry.allInputs()) {
    m[inp.id] = defaultForSchema(inp.schema as ZodTypeAny);
  }
  return m;
}

function firstSeedInputId(registry: Registry): string {
  const im = registry
    .allInputs()
    .filter((i) => i.kind === "input" && !i.secret);
  return im[0]?.id ?? "";
}

function findDeferredWait(
  state: RunState | undefined,
): { stepId: string; inputId: string } | undefined {
  if (!state?.nodes) return undefined;
  for (const [stepId, n] of Object.entries(state.nodes)) {
    if (n.status === "waiting" && n.waitingOn) {
      if (state.nodes[n.waitingOn]?.status === "resolved") continue;
      return { stepId, inputId: n.waitingOn };
    }
  }
  return undefined;
}

function immediateInputNeedsForm(
  nodeId: string | null,
  runState: RunState | undefined,
): boolean {
  if (!nodeId) return false;
  const def = globalRegistry.getInput(nodeId);
  if (!def || def.kind !== "input" || def.secret) return false;
  return !runState?.nodes[nodeId];
}

function deferredInputNeedsForm(
  runState: RunState | undefined,
  nodeId: string | null,
): boolean {
  if (!nodeId || !runState) return false;
  const def = globalRegistry.getInput(nodeId);
  if (!def || def.kind !== "deferred_input") return false;
  if (runState.nodes[nodeId]?.status === "resolved") return false;
  return deferredInputRequested(globalRegistry, runState, nodeId);
}

function isRunComplete(runState: RunState | undefined): boolean {
  if (!runState) return false;
  if (Object.keys(runState.nodes).length === 0) return false;
  if (findDeferredWait(runState)) return false;
  for (const n of Object.values(runState.nodes)) {
    if (n.status === "waiting" || n.status === "blocked") return false;
    if (n.status === "errored") return false;
  }
  return true;
}

function displayNodeRecord(
  registry: Registry,
  nodeId: string | null,
  record: RunState["nodes"][string] | undefined,
): RunState["nodes"][string] | undefined {
  if (!nodeId || !record) return record;
  const def = registry.getInput(nodeId);
  if (!def?.secret || record.value === undefined) return record;
  return { ...record, value: "[secret]" };
}

type NextQueuedWork = {
  id: string;
  type: "Input" | "Step";
  description?: string;
};

function nextQueuedWork(
  queue: QueueSnapshot | undefined,
  registry: Registry,
): NextQueuedWork | undefined {
  const event = queue?.pending[0]?.event;
  if (!event) return undefined;

  const id = event.kind === "input" ? event.inputId : event.stepId;
  const def = registry.getInput(id) ?? registry.getAtom(id);
  return {
    id,
    type: event.kind === "input" ? "Input" : "Step",
    description: def?.description,
  };
}

function shortRunId(runId: string): string {
  return runId.replace(/^run_/, "").slice(0, 8);
}

function formatRunTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function runStatusLabel(status: RunSummary["status"]): string {
  switch (status) {
    case "created":
      return "Created";
    case "running":
      return "Running";
    case "waiting":
      return "Waiting";
    case "completed":
      return "Complete";
    case "failed":
      return "Failed";
    case "canceled":
      return "Canceled";
    default:
      return status;
  }
}

function runStatusClass(status: RunSummary["status"]): string {
  switch (status) {
    case "running":
      return "bg-blue-500";
    case "waiting":
      return "bg-yellow-500";
    case "completed":
      return "bg-emerald-500";
    case "failed":
      return "bg-red-500";
    case "canceled":
      return "bg-zinc-500";
    case "created":
      return "bg-muted-foreground";
    default:
      return "bg-muted-foreground";
  }
}

export function IndexApp() {
  const { workflows, isPending, createWorkflow, deleteWorkflow, error } =
    useWorkflows();
  const navigate = useNavigate();
  const [uploadError, setUploadError] = useState<string | undefined>();
  const [uploading, setUploading] = useState(false);
  const [deletingWorkflowId, setDeletingWorkflowId] = useState<
    string | undefined
  >();

  async function uploadDefault() {
    setUploadError(undefined);
    setUploading(true);
    try {
      const manifest = await createWorkflow({
        workflowSource: workflowRaw,
        workflowId: "default",
        name: "Onboarding demo",
      });
      void navigate({
        to: "/workflows/$workflowId",
        params: { workflowId: manifest.workflowId },
      });
    } catch (e) {
      setUploadError(
        e instanceof Error ? e.message : "Failed to upload workflow.",
      );
    } finally {
      setUploading(false);
    }
  }

  async function removeWorkflow(workflowId: string) {
    setUploadError(undefined);
    setDeletingWorkflowId(workflowId);
    try {
      await deleteWorkflow(workflowId);
    } catch (e) {
      setUploadError(
        e instanceof Error ? e.message : `Failed to delete ${workflowId}.`,
      );
    } finally {
      setDeletingWorkflowId(undefined);
    }
  }

  if (isPending && workflows.length === 0 && !uploading) {
    return (
      <div className="flex h-screen items-center justify-center text-muted-foreground text-sm">
        Loading workflows…
      </div>
    );
  }

  if (workflows.length === 0) {
    return (
      <div className="flex h-screen items-center justify-center p-6">
        <div className="flex max-w-md flex-col items-center gap-4 rounded-xl border border-border bg-card p-8 text-center shadow-sm">
          <p className="text-sm text-muted-foreground leading-relaxed">
            No workflows yet. Upload the bundled default to get started.
          </p>
          <Button
            type="button"
            onClick={() => void uploadDefault()}
            disabled={uploading}
          >
            {uploading ? "Uploading…" : "Upload default workflow"}
          </Button>
          {uploadError || error ? (
            <p className="text-destructive text-xs">
              {uploadError ?? error?.message}
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex min-h-10 items-center justify-between border-b border-border px-4 py-3">
        <h1 className="text-sm font-semibold tracking-tight md:text-base">
          Workflows
        </h1>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void uploadDefault()}
          disabled={uploading || isPending}
        >
          {uploading ? "Uploading..." : "Upload default"}
        </Button>
      </header>
      <div className="flex-1 overflow-y-auto p-4">
        <ul className="mx-auto flex max-w-2xl flex-col gap-2">
          {workflows.map((w) => (
            <li
              key={w.workflowId}
              className="grid grid-cols-[minmax(0,1fr)_auto] gap-2"
            >
              <button
                type="button"
                onClick={() =>
                  void navigate({
                    to: "/workflows/$workflowId",
                    params: { workflowId: w.workflowId },
                  })
                }
                className="flex w-full flex-col items-start gap-1 rounded-lg border border-border bg-card px-4 py-3 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <span className="text-sm font-medium text-foreground">
                  {w.name ?? w.workflowId}
                </span>
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  <code className="rounded bg-muted px-1 py-0.5">
                    {w.workflowId}
                  </code>
                  <span>{formatRunTime(w.createdAt)}</span>
                </span>
              </button>
              <Button
                type="button"
                size="icon"
                variant="outline"
                aria-label={`Delete ${w.workflowId}`}
                title={`Delete ${w.workflowId}`}
                disabled={isPending || deletingWorkflowId === w.workflowId}
                onClick={() => void removeWorkflow(w.workflowId)}
              >
                <Trash2 className="size-4" aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
        {uploadError || error ? (
          <p className="mx-auto mt-3 max-w-2xl text-destructive text-xs">
            {uploadError ?? error?.message}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function NotFoundScreen({ workflowId }: { workflowId: string }) {
  const navigate = useNavigate();
  return (
    <div className="flex h-screen items-center justify-center p-6">
      <div className="flex max-w-md flex-col items-center gap-4 rounded-xl border border-border bg-card p-8 text-center shadow-sm">
        <p className="text-sm font-semibold text-foreground">
          Workflow not found
        </p>
        <p className="text-muted-foreground text-xs leading-relaxed">
          No workflow with id{" "}
          <code className="rounded bg-muted px-1 py-0.5">{workflowId}</code>.
        </p>
        <Button
          type="button"
          onClick={() => void navigate({ to: "/", replace: true })}
        >
          Go home
        </Button>
      </div>
    </div>
  );
}

export function WorkflowApp() {
  const { workflowId } = useParams({ from: "/workflows/$workflowId" });
  return <App workflowId={workflowId} />;
}

export function RunApp() {
  const { workflowId, runId } = useParams({
    from: "/workflows/$workflowId/runs/$runId",
  });
  return <App workflowId={workflowId} runId={runId} />;
}

function App({ workflowId, runId }: { workflowId: string; runId?: string }) {
  const navigate = useNavigate();
  const workflow = useWorkflow(workflowId);
  const workflowRun = useWorkflowRun(runId);
  const { deleteWorkflow } = useWorkflows();

  const [pane, setPane] = useState<SidePane>(null);
  const [appliedSource, setAppliedSource] = useState<string | undefined>();
  const [inputValues, setInputValues] = useState<Record<string, unknown>>(() =>
    buildInitialInputValues(globalRegistry),
  );
  const [seedInputId, setSeedInputId] = useState(() =>
    firstSeedInputId(globalRegistry),
  );
  const [payloadError, setPayloadError] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [pendingAutoAdvance, setPendingAutoAdvance] = useState(false);
  const [deletingWorkflow, setDeletingWorkflow] = useState(false);

  const manifestSource = workflow.manifest?.source;
  const runSource = workflowRun.workflowSource;
  const activeSource = runSource ?? manifestSource;

  useEffect(() => {
    if (!activeSource) return;
    if (activeSource === appliedSource) return;
    try {
      loadWorkflowSourceIntoGlobalRegistry(activeSource);
      setAppliedSource(activeSource);
      setInputValues(buildInitialInputValues(globalRegistry));
      setSeedInputId(firstSeedInputId(globalRegistry));
    } catch (e) {
      setPayloadError(
        e instanceof Error
          ? e.message
          : "Workflow source could not be evaluated.",
      );
    }
  }, [activeSource, appliedSource]);

  const runState = workflowRun.runState;
  const wait = findDeferredWait(runState);
  const pendingDeferredId = wait?.inputId;
  const inputPending = Boolean(pendingDeferredId);

  const nodes = runState?.nodes ?? {};
  const nextWork = nextQueuedWork(workflowRun.queue, globalRegistry);
  const runComplete = workflowRun.snapshot
    ? workflowRun.snapshot.status === "completed"
    : isRunComplete(runState);
  const activeAutoAdvance = workflowRun.autoAdvance ?? pendingAutoAdvance;
  const isPending = workflow.isPending || workflowRun.isPending;
  const canManualAdvance = Boolean(
    runState && !runComplete && !activeAutoAdvance && nextWork,
  );

  useEffect(() => {
    if (!selectedNodeId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedNodeId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedNodeId]);

  useEffect(() => {
    if (!pane) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPane(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pane]);

  function setInputValue(id: string, value: unknown) {
    setInputValues((prev) => ({ ...prev, [id]: value }));
  }

  function clearRun() {
    workflowRun.clear();
    setSelectedNodeId(null);
    setInputValues(buildInitialInputValues(globalRegistry));
    setSeedInputId(firstSeedInputId(globalRegistry));
    setPayloadError("");
    setPane(null);
    void navigate({
      to: "/workflows/$workflowId",
      params: { workflowId },
    });
  }

  async function runWorkflow(seedOverride?: string) {
    setPayloadError("");
    const id = seedOverride ?? seedInputId;
    const seed = globalRegistry.getInput(id);
    if (!seed || seed.kind !== "input" || seed.secret) {
      setPayloadError("No initial input is registered for this workflow.");
      return;
    }
    let payload: unknown;
    const additionalInputs: { inputId: string; payload: unknown }[] = [];
    try {
      payload = seed.schema.parse(inputValues[seed.id]);
      for (const secretInput of globalRegistry.allInputs()) {
        if (secretInput.kind !== "input" || !secretInput.secret) continue;
        additionalInputs.push({
          inputId: secretInput.id,
          payload: secretInput.schema.parse(inputValues[secretInput.id]),
        });
      }
    } catch (e) {
      setPayloadError(
        e instanceof Error
          ? e.message
          : "Validation failed for the initial inputs.",
      );
      return;
    }

    try {
      const result = await workflow.start({
        inputId: seed.id,
        payload,
        additionalInputs,
        autoAdvance: pendingAutoAdvance,
      });
      void navigate({
        to: "/workflows/$workflowId/runs/$runId",
        params: { workflowId, runId: result.state.runId },
      });
      setPane(null);
    } catch (e) {
      setPayloadError(
        e instanceof Error
          ? e.message
          : "Processing failed — check input values.",
      );
    }
  }

  async function submitDeferredInput(explicitInputId?: string) {
    const inputId = explicitInputId ?? pendingDeferredId;
    if (!inputId) return;
    if (inputId !== pendingDeferredId) {
      setPayloadError(
        `This run is waiting on "${pendingDeferredId ?? "—"}", not "${inputId}".`,
      );
      return;
    }
    const def = globalRegistry.getInput(inputId);
    if (!def) return;

    setPayloadError("");
    let payload: unknown;
    try {
      payload = def.schema.parse(inputValues[inputId]);
    } catch (e) {
      setPayloadError(
        e instanceof Error ? e.message : `Validation failed for "${inputId}".`,
      );
      return;
    }

    try {
      await workflowRun.submitInput({
        workflowSource: runSource ?? manifestSource ?? "",
        state: runState,
        inputId,
        payload,
        autoAdvance: activeAutoAdvance,
      });
      setPane(null);
    } catch (e) {
      setPayloadError(
        e instanceof Error
          ? e.message
          : "Processing failed — check input values.",
      );
    }
  }

  async function advanceWorkflow() {
    if (!runState) return;
    setPayloadError("");
    try {
      await workflowRun.advance({
        workflowSource: runSource ?? manifestSource ?? "",
        state: runState,
      });
      setPane(null);
    } catch (e) {
      setPayloadError(
        e instanceof Error
          ? e.message
          : "Processing failed — check workflow code.",
      );
    }
  }

  async function changeAdvanceMode(nextAutoAdvance: boolean) {
    if (nextAutoAdvance === activeAutoAdvance) return;
    setPendingAutoAdvance(nextAutoAdvance);
    if (!runState) return;

    setPayloadError("");
    try {
      await workflowRun.setAutoAdvance({
        state: runState,
        autoAdvance: nextAutoAdvance,
      });
    } catch (e) {
      setPendingAutoAdvance(!nextAutoAdvance);
      setPayloadError(
        e instanceof Error ? e.message : "Unable to change advance mode.",
      );
    }
  }

  async function deleteCurrentWorkflow() {
    setPayloadError("");
    setDeletingWorkflow(true);
    try {
      await deleteWorkflow(workflowId);
      workflowRun.clear();
      void navigate({ to: "/", replace: true });
    } catch (e) {
      setPayloadError(
        e instanceof Error ? e.message : `Failed to delete ${workflowId}.`,
      );
    } finally {
      setDeletingWorkflow(false);
    }
  }

  const selectedRecord = displayNodeRecord(
    globalRegistry,
    selectedNodeId,
    selectedNodeId ? nodes[selectedNodeId] : undefined,
  );

  let nodeEditor: NodeDetailEditor | null = null;
  if (selectedNodeId) {
    const def = globalRegistry.getInput(selectedNodeId);
    if (def && immediateInputNeedsForm(selectedNodeId, runState)) {
      nodeEditor = {
        inputDescription: def.description,
        description:
          "Submit this payload as the seed input event (same as Start Workflow).",
        schema: def.schema as ZodTypeAny,
        secret: def.secret,
        value: inputValues[selectedNodeId],
        onChange: (v) => setInputValue(selectedNodeId, v),
        onSubmit: () => void runWorkflow(selectedNodeId),
        submitLabel: `Submit “${selectedNodeId}”`,
        error: payloadError || undefined,
      };
    } else if (def && deferredInputNeedsForm(runState, selectedNodeId)) {
      const id = selectedNodeId;
      nodeEditor = {
        inputDescription: def.description,
        description:
          "Deferred input: delivered as a separate queue event when this step is waiting (SPEC: WaitError).",
        schema: def.schema as ZodTypeAny,
        secret: def.secret,
        value: inputValues[id],
        onChange: (v) => setInputValue(id, v),
        onSubmit: () => void submitDeferredInput(id),
        submitLabel: `Submit “${id}”`,
        error: payloadError || undefined,
      };
    }
  }

  if (workflow.manifestNotFound) {
    return <NotFoundScreen workflowId={workflowId} />;
  }

  return (
    <div className="flex h-screen min-h-0 flex-col bg-background">
      <header className="flex min-h-10 flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h1 className="min-w-0">
          <button
            type="button"
            onClick={() => void navigate({ to: "/" })}
            className="rounded-sm text-sm font-semibold tracking-tight outline-none hover:text-primary focus-visible:ring-3 focus-visible:ring-ring/50 md:text-base"
          >
            {workflow.manifest?.name ?? "Workflow"}
          </button>
        </h1>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
          {runId && (
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
          <Button
            size="icon-sm"
            variant="outline"
            onClick={() => void deleteCurrentWorkflow()}
            disabled={deletingWorkflow}
            aria-label="Delete workflow"
            title="Delete workflow"
          >
            <Trash2 className="size-3.5" aria-hidden />
          </Button>
          <fieldset
            aria-label="Advance mode"
            className="inline-flex h-7 shrink-0 overflow-hidden rounded-lg border border-border bg-background text-[0.8rem] font-medium dark:border-input dark:bg-input/30"
          >
            <button
              type="button"
              aria-pressed={!activeAutoAdvance}
              title="Manual advance"
              disabled={isPending}
              onClick={() => void changeAdvanceMode(false)}
              className={cn(
                "inline-flex h-full w-[4.9rem] items-center justify-center gap-1 px-2 transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50",
                !activeAutoAdvance
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              <Pause className="size-3.5 shrink-0" aria-hidden />
              Manual
            </button>
            <button
              type="button"
              aria-pressed={activeAutoAdvance}
              title="Auto advance"
              disabled={isPending}
              onClick={() => void changeAdvanceMode(true)}
              className={cn(
                "inline-flex h-full w-[4.4rem] items-center justify-center gap-1 border-l border-border px-2 transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 dark:border-input",
                activeAutoAdvance
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              <Play className="size-3.5 shrink-0" aria-hidden />
              Auto
            </button>
          </fieldset>
          {canManualAdvance && (
            <>
              <div
                className="inline-flex h-7 max-w-[16rem] items-center gap-1.5 rounded-lg border border-muted-foreground/20 bg-muted/45 px-2.5 text-[0.8rem] font-medium text-foreground dark:bg-muted/35"
                title={
                  nextWork?.description
                    ? `${nextWork.type} ${nextWork.id}: ${nextWork.description}`
                    : `${nextWork?.type} ${nextWork?.id}`
                }
              >
                <span className="shrink-0 text-muted-foreground">Next</span>
                <span className="shrink-0 text-muted-foreground">
                  {nextWork?.type}
                </span>
                <span className="min-w-0 truncate">{nextWork?.id}</span>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void advanceWorkflow()}
                disabled={isPending}
                title={
                  nextWork
                    ? `Advance will run ${nextWork.type.toLowerCase()} "${nextWork.id}" from the queue.`
                    : undefined
                }
              >
                <SkipForward className="size-3.5 shrink-0" aria-hidden />
                Advance
              </Button>
            </>
          )}
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

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-48 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground sm:w-64 lg:w-72">
          <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-sidebar-border px-2.5">
            <div className="flex min-w-0 items-center gap-2 text-sm font-semibold">
              <History className="size-4 shrink-0" aria-hidden />
              <span className="truncate">Runs</span>
            </div>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              title="Refresh runs"
              aria-label="Refresh runs"
              onClick={() => void workflow.refreshRuns()}
            >
              <RefreshCw className="size-3.5" aria-hidden />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {workflow.runs.length === 0 ? (
              <div className="px-2 py-3 text-xs text-muted-foreground">
                No runs
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                {workflow.runs.map((run) => {
                  const active = run.runId === runId;
                  return (
                    <button
                      key={run.runId}
                      type="button"
                      onClick={() =>
                        void navigate({
                          to: "/workflows/$workflowId/runs/$runId",
                          params: { workflowId, runId: run.runId },
                        })
                      }
                      disabled={isPending}
                      aria-current={active ? "true" : undefined}
                      className={cn(
                        "grid min-h-20 w-full grid-cols-[auto_minmax(0,1fr)] gap-x-2 rounded-lg border border-transparent px-2.5 py-2 text-left text-sm outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-3 focus-visible:ring-sidebar-ring/50 disabled:pointer-events-none disabled:opacity-60",
                        active &&
                          "border-sidebar-border bg-sidebar-accent text-sidebar-accent-foreground shadow-sm",
                      )}
                    >
                      <span
                        className={cn(
                          "mt-1 size-2 rounded-full",
                          runStatusClass(run.status),
                        )}
                        aria-hidden
                      />
                      <span className="min-w-0">
                        <span className="flex min-w-0 items-center justify-between gap-2">
                          <span className="min-w-0 truncate font-medium">
                            {shortRunId(run.runId)}
                          </span>
                          <span className="shrink-0 text-[0.7rem] font-medium text-muted-foreground">
                            {runStatusLabel(run.status)}
                          </span>
                        </span>
                        <span className="mt-1 flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                          <Clock3 className="size-3 shrink-0" aria-hidden />
                          <span className="min-w-0 truncate">
                            {formatRunTime(run.startedAt)}
                          </span>
                        </span>
                        {run.waitingOn.length > 0 && (
                          <span className="mt-1 block truncate text-xs text-muted-foreground">
                            Waiting on {run.waitingOn.join(", ")}
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </aside>
        <div className="relative min-w-0 flex-1">
          <QueueVisualizer
            runState={runState}
            queue={workflowRun.queue}
            registry={globalRegistry}
            onNodeClick={(id) => setSelectedNodeId(id)}
          />

          {!runState && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-6">
              <div className="pointer-events-auto flex max-w-md flex-col items-center gap-5 rounded-xl border border-border bg-card/95 p-8 text-center shadow-lg backdrop-blur-sm">
                <p className="text-muted-foreground text-sm leading-relaxed">
                  No run yet. Preview your input and start.
                </p>
                <Button type="button" onClick={() => setPane("start")}>
                  Start Workflow
                </Button>
              </div>
            </div>
          )}

          <WorkflowCodeSheet
            open={pane === "workflow"}
            onOpenChange={(o) => setPane(o ? "workflow" : null)}
            workflowCode={activeSource ?? ""}
            readOnly
          />

          <RunStateJsonSheet
            open={pane === "state"}
            onOpenChange={(o) => setPane(o ? "state" : null)}
            runState={runState}
            registry={globalRegistry}
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
              if (!open) setSelectedNodeId(null);
            }}
          />
        </div>
      </div>
    </div>
  );
}

export default App;
