"use client";

import type { Registry, RunState } from "@workflow/core";
import { globalRegistry } from "@workflow/core";
import type { QueueSnapshot } from "@workflow/runtime";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Clock3,
  History,
  KeyRound,
  Pause,
  Play,
  Plus,
  RefreshCw,
  SkipForward,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { ZodError, type ZodTypeAny } from "zod";
import {
  defaultForJsonSchema,
  sanitizeJsonSchemaValue,
} from "./components/json-schema-form";
import {
  type NodeDetailEditor,
  NodeDetailSheet,
} from "./components/node-detail-sheet";
import { PendingInputSheet } from "./components/pending-input-sheet";
import {
  deferredInputRequested,
  QueueVisualizer,
} from "./components/queue-visualizer";
import { RunStateJsonSheet } from "./components/run-state-json-sheet";
import { StartWorkflowSheet } from "./components/start-workflow-sheet";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { WorkflowFrontendRoot } from "./config";
import {
  useSecretVault,
  useWorkflow,
  useWorkflowRun,
} from "./hooks/use-workflow";
import { cn } from "./lib/utils";
import type {
  RunSummary,
  WorkflowInputManifest,
  WorkflowManifest,
} from "./types";

type SidePane = null | "start" | "pending" | "state";

export type WorkflowNavigation = {
  home(): void;
  vault?(): void;
  workflow(workflowId: string, options?: { replace?: boolean }): void;
  run(workflowId: string, runId: string): void;
};

const noopNavigation: WorkflowNavigation = {
  home() {},
  workflow() {},
  run() {},
};

function buildInitialManifestInputValues(
  manifest: WorkflowManifest | undefined,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const input of manifest?.inputs ?? []) {
    values[input.id] = defaultForJsonSchema(input.schema);
  }
  return values;
}

function firstManifestSeedInputId(
  manifest: WorkflowManifest | undefined,
): string {
  const immediate = manifest?.inputs.filter((input) => input.kind === "input");
  return (
    immediate?.find((input) => !input.secret)?.id ?? immediate?.[0]?.id ?? ""
  );
}

function findManifestInput(
  manifest: WorkflowManifest | undefined,
  inputId: string | undefined,
): WorkflowInputManifest | undefined {
  if (!inputId) return undefined;
  return manifest?.inputs.find((input) => input.id === inputId);
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

function errorMessage(error: unknown, fallback: string): string {
  const issues = zodIssues(error);
  if (issues) {
    return issues
      .map((issue) => {
        const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
        return `${path}${issue.message}`;
      })
      .join("\n");
  }
  return error instanceof Error ? error.message : fallback;
}

type ZodIssueLike = {
  message: string;
  path: (string | number)[];
};

function zodIssues(error: unknown): ZodIssueLike[] | undefined {
  if (error instanceof ZodError) return error.issues;
  if (!error || typeof error !== "object") return undefined;
  const issues = (error as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return undefined;
  if (
    !issues.every(
      (issue): issue is ZodIssueLike =>
        issue &&
        typeof issue === "object" &&
        typeof (issue as { message?: unknown }).message === "string" &&
        Array.isArray((issue as { path?: unknown }).path),
    )
  ) {
    return undefined;
  }
  return issues;
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

export function SecretVaultApp({
  navigation = noopNavigation,
}: {
  navigation?: Pick<WorkflowNavigation, "home">;
}) {
  const vault = useSecretVault();
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [scope, setScope] = useState<"user" | "organization">("user");
  const [formError, setFormError] = useState<string | undefined>();

  async function createSecret() {
    setFormError(undefined);
    if (!name.trim()) {
      setFormError("Name is required.");
      return;
    }
    if (!value) {
      setFormError("Value is required.");
      return;
    }

    try {
      await vault.create({
        name: name.trim(),
        key: key.trim() || undefined,
        value,
        scope,
      });
      setName("");
      setKey("");
      setValue("");
      setScope("user");
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Unable to create secret.");
    }
  }

  async function deleteSecret(secretId: string) {
    setFormError(undefined);
    try {
      await vault.deleteEntry(secretId);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Unable to delete secret.");
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex min-h-10 flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Button
            type="button"
            size="icon-sm"
            variant="outline"
            onClick={() => navigation.home()}
            aria-label="Back to workflow"
            title="Back to workflow"
          >
            <ArrowLeft className="size-3.5" aria-hidden />
          </Button>
          <div className="flex min-w-0 items-center gap-2">
            <KeyRound className="size-4 shrink-0" aria-hidden />
            <h1 className="truncate text-sm font-semibold tracking-tight md:text-base">
              Secret Vault
            </h1>
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void vault.refresh()}
          disabled={vault.isPending}
        >
          <RefreshCw className="size-3.5" aria-hidden />
          Refresh
        </Button>
      </header>

      <main className="mx-auto grid w-full max-w-4xl flex-1 grid-cols-1 gap-4 p-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
        <form
          className="grid content-start gap-3 border-border border-b pb-4 lg:border-r lg:border-b-0 lg:pr-4 lg:pb-0"
          onSubmit={(e) => {
            e.preventDefault();
            void createSecret();
          }}
        >
          <div className="grid gap-1.5">
            <label className="text-xs font-medium" htmlFor="vault-name">
              Name
            </label>
            <Input
              id="vault-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Prod LLM Gateway"
            />
          </div>
          <div className="grid gap-1.5">
            <label className="text-xs font-medium" htmlFor="vault-key">
              Key
            </label>
            <Input
              id="vault-key"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="LLM_GATEWAY_API_KEY"
            />
          </div>
          <div className="grid gap-1.5">
            <label className="text-xs font-medium" htmlFor="vault-value">
              Value
            </label>
            <Input
              id="vault-value"
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Secret value"
            />
          </div>
          <div className="grid gap-1.5">
            <label className="text-xs font-medium" htmlFor="vault-scope">
              Scope
            </label>
            <select
              id="vault-scope"
              className="flex h-8 w-full rounded-lg border border-input bg-background px-2 text-sm dark:bg-input/30"
              value={scope}
              onChange={(e) =>
                setScope(
                  e.target.value === "organization" ? "organization" : "user",
                )
              }
            >
              <option value="user">User</option>
              <option value="organization">Organization</option>
            </select>
          </div>
          <Button type="submit" disabled={vault.isPending}>
            <Plus className="size-4" aria-hidden />
            Add Secret
          </Button>
          {formError || vault.error ? (
            <p className="text-destructive text-xs">
              {formError ?? vault.error?.message}
            </p>
          ) : null}
        </form>

        <section className="min-w-0">
          {vault.entries.length === 0 ? (
            <div className="flex min-h-40 items-center justify-center rounded-lg border border-border bg-card p-6 text-muted-foreground text-sm">
              No secrets
            </div>
          ) : (
            <ul className="grid gap-2">
              {vault.entries.map((entry) => (
                <li
                  key={entry.id}
                  className="grid min-h-16 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-lg border border-border bg-card px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="truncate font-medium text-sm">
                        {entry.name}
                      </span>
                      <Badge variant="outline">{entry.scope}</Badge>
                    </div>
                    <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2 text-muted-foreground text-xs">
                      {entry.key ? (
                        <code className="rounded bg-muted px-1 py-0.5">
                          {entry.key}
                        </code>
                      ) : null}
                      <span>{formatRunTime(entry.updatedAt)}</span>
                    </div>
                  </div>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="outline"
                    aria-label={`Delete ${entry.name}`}
                    title={`Delete ${entry.name}`}
                    onClick={() => void deleteSecret(entry.id)}
                    disabled={vault.isPending}
                  >
                    <Trash2 className="size-3.5" aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}

function NotFoundScreen({
  workflowId,
  navigation,
}: {
  workflowId: string;
  navigation: WorkflowNavigation;
}) {
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
        <Button type="button" onClick={() => navigation.home()}>
          Go home
        </Button>
      </div>
    </div>
  );
}

export function WorkflowRunnerApp({
  workflowId,
  runId,
  navigation = noopNavigation,
}: {
  workflowId: string;
  runId?: string;
  navigation?: WorkflowNavigation;
}) {
  const workflow = useWorkflow(workflowId);
  const workflowRun = useWorkflowRun(runId);

  const [pane, setPane] = useState<SidePane>(null);
  const [inputValues, setInputValues] = useState<Record<string, unknown>>(() =>
    buildInitialManifestInputValues(undefined),
  );
  const [seedInputId, setSeedInputId] = useState("");
  const [payloadError, setPayloadError] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [pendingAutoAdvance, setPendingAutoAdvance] = useState(false);

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
    if (!workflow.manifest) return;
    setInputValues((current) => ({
      ...buildInitialManifestInputValues(workflow.manifest),
      ...current,
    }));
    setSeedInputId(
      (current) => current || firstManifestSeedInputId(workflow.manifest),
    );
  }, [workflow.manifest]);

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

  function collectSecretValues(): Record<string, string> {
    const secretValues: Record<string, string> = {};
    for (const input of workflow.manifest?.inputs ?? []) {
      if (!input.secret) continue;
      const value = inputValues[input.id];
      if (typeof value === "string" && value.length > 0) {
        secretValues[input.id] = value;
      }
    }
    return secretValues;
  }

  function clearRun() {
    workflowRun.clear();
    setSelectedNodeId(null);
    setInputValues(buildInitialManifestInputValues(workflow.manifest));
    setSeedInputId(firstManifestSeedInputId(workflow.manifest));
    setPayloadError("");
    setPane(null);
    navigation.workflow(workflowId);
  }

  async function runWorkflow(seedOverride?: string) {
    setPayloadError("");
    const immediate =
      workflow.manifest?.inputs.filter((input) => input.kind === "input") ?? [];
    const id =
      seedOverride ??
      (seedInputId || firstManifestSeedInputId(workflow.manifest));
    const seed = immediate.find((input) => input.id === id) ?? immediate[0];
    if (!seed) {
      setPayloadError("No initial input is registered for this workflow.");
      return;
    }
    let payload: unknown;
    let additionalInputs: { inputId: string; payload: unknown }[] | undefined;
    const secretValues = collectSecretValues();
    try {
      payload = sanitizeJsonSchemaValue(seed.schema, inputValues[seed.id]);
      additionalInputs = immediate
        .filter((input) => input.id !== seed.id)
        .filter((input) => !input.secret || secretValues[input.id])
        .map((input) => ({
          inputId: input.id,
          payload: input.secret
            ? secretValues[input.id]
            : sanitizeJsonSchemaValue(input.schema, inputValues[input.id]),
        }));
    } catch (e) {
      setPayloadError(
        errorMessage(e, "Validation failed for the initial inputs."),
      );
      return;
    }

    try {
      const result = await workflow.start({
        inputId: seed.id,
        payload,
        additionalInputs,
        secretValues,
        autoAdvance: pendingAutoAdvance,
      });
      navigation.run(workflowId, result.state.runId);
      setPane(null);
    } catch (e) {
      setPayloadError(
        errorMessage(e, "Processing failed — check input values."),
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
    const def = findManifestInput(workflow.manifest, inputId);
    if (!def) return;

    setPayloadError("");
    let payload: unknown;
    const secretValues = collectSecretValues();
    try {
      payload = sanitizeJsonSchemaValue(def.schema, inputValues[inputId]);
      if (def.secret && typeof payload === "string" && payload.length > 0) {
        secretValues[inputId] = payload;
      }
    } catch (e) {
      setPayloadError(errorMessage(e, `Validation failed for "${inputId}".`));
      return;
    }

    try {
      await workflowRun.submitInput({
        state: runState,
        inputId,
        payload,
        secretValues,
        autoAdvance: activeAutoAdvance,
      });
      setPane(null);
    } catch (e) {
      setPayloadError(
        errorMessage(e, "Processing failed — check input values."),
      );
    }
  }

  async function advanceWorkflow() {
    if (!runState) return;
    setPayloadError("");
    try {
      await workflowRun.advance({
        state: runState,
        secretValues: collectSecretValues(),
      });
      setPane(null);
    } catch (e) {
      setPayloadError(
        errorMessage(e, "Processing failed — check workflow code."),
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
        secretValues: collectSecretValues(),
      });
    } catch (e) {
      setPendingAutoAdvance(!nextAutoAdvance);
      setPayloadError(errorMessage(e, "Unable to change advance mode."));
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
    return <NotFoundScreen workflowId={workflowId} navigation={navigation} />;
  }

  return (
    <div className="flex h-screen min-h-0 flex-col bg-background">
      <header className="flex min-h-10 flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h1 className="min-w-0">
          <button
            type="button"
            onClick={() => navigation.home()}
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
            onClick={() => setPane("state")}
            aria-expanded={pane === "state"}
            title="Full run state including every node record"
          >
            Run state
          </Button>
          {navigation.vault ? (
            <Button
              size="icon-sm"
              variant="outline"
              onClick={() => navigation.vault?.()}
              aria-label="Open secret vault"
              title="Open secret vault"
            >
              <KeyRound className="size-3.5" aria-hidden />
            </Button>
          ) : null}
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
                      onClick={() => navigation.run(workflowId, run.runId)}
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
            vaultEntries={secretVault.entries}
            secretBindings={secretBindings}
            onSecretBindingChange={setSecretBinding}
            newSecretValues={newSecretValues}
            onNewSecretValueChange={setNewSecretValue}
            canSubmitSeed={!runState}
            onSubmitSeed={() => void runWorkflow()}
            error={
              pane === "start"
                ? payloadError || secretVault.error?.message || undefined
                : undefined
            }
          />

          <PendingInputSheet
            open={pane === "pending" && Boolean(pendingDeferredId)}
            onOpenChange={(o) => setPane(o ? "pending" : null)}
            registry={globalRegistry}
            pendingInputId={pendingDeferredId}
            inputValues={inputValues}
            onInputValuesChange={setInputValue}
            vaultEntries={secretVault.entries}
            secretBindings={secretBindings}
            onSecretBindingChange={setSecretBinding}
            newSecretValues={newSecretValues}
            onNewSecretValueChange={setNewSecretValue}
            onSubmit={() => void submitDeferredInput()}
            onBindSecret={() => void bindPendingSecret()}
            error={
              pane === "pending"
                ? payloadError || secretVault.error?.message || undefined
                : undefined
            }
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

export function WorkflowSingleApp() {
  const workflow = useWorkflow(undefined);
  const [runId, setRunId] = useState<string | undefined>();
  const manifest = workflow.manifest;

  if (workflow.isPending && !manifest) {
    return (
      <div className="flex h-screen items-center justify-center text-muted-foreground text-sm">
        Loading workflow...
      </div>
    );
  }

  if (!manifest) {
    return (
      <div className="flex h-screen items-center justify-center p-6">
        <div className="flex max-w-md flex-col items-center gap-4 rounded-xl border border-border bg-card p-8 text-center shadow-sm">
          <p className="text-sm font-semibold text-foreground">
            Workflow unavailable
          </p>
          {workflow.error ? (
            <p className="text-destructive text-xs">{workflow.error.message}</p>
          ) : null}
        </div>
      </div>
    );
  }

  const navigation: WorkflowNavigation = {
    home: () => setRunId(undefined),
    workflow: () => setRunId(undefined),
    run: (_workflowId, nextRunId) => setRunId(nextRunId),
  };

  return (
    <WorkflowRunnerApp
      workflowId={manifest.workflowId}
      runId={runId}
      navigation={navigation}
    />
  );
}

export function WorkflowSinglePage({
  apiBaseUrl = "/api/workflow",
}: {
  apiBaseUrl?: string;
}) {
  return (
    <WorkflowFrontendRoot config={{ apiBaseUrl }}>
      <WorkflowSingleApp />
    </WorkflowFrontendRoot>
  );
}
