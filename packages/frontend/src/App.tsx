"use client";

import type { InterventionRequest, Registry, RunState } from "@workflow/core";
import { globalRegistry } from "@workflow/core";
import {
  ArrowLeft,
  Check,
  Clock3,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { ZodError } from "zod";
import {
  defaultForJsonSchema,
  sanitizeJsonSchemaValue,
} from "./components/json-schema-form";
import {
  type NodeDetailEditor,
  NodeDetailSheet,
  type NodeIntervention,
} from "./components/node-detail-sheet";
import {
  type PendingFormRequest,
  PendingInputSheet,
} from "./components/pending-input-sheet";
import {
  QueueVisualizer,
  workflowInputRequested,
} from "./components/queue-visualizer";
import { RunStateJsonSheet } from "./components/run-state-json-sheet";
import { SchedulesPanel } from "./components/schedules-panel";
import {
  type ManagedConnectionDisplayState,
  StartWorkflowForm,
} from "./components/start-workflow-form";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import { useWorkflowFrontendConfig, WorkflowFrontendRoot } from "./config";
import { useSecretVault, useWorkflow } from "./hooks/use-workflow";
import { useWorkflowRun, WorkflowRunProvider } from "./hooks/workflow-run";
import { findPendingWait } from "./lib/pending-wait";
import { cn } from "./lib/utils";
import { workflowInputLabel } from "./lib/workflow-labels";
import type {
  RunSummary,
  WorkflowConfigurationDocument,
  WorkflowInputManifest,
  WorkflowManifest,
} from "./types";

type SidePane = null | "pending" | "state";

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

function findManifestInput(
  manifest: WorkflowManifest | undefined,
  inputId: string | undefined,
): WorkflowInputManifest | undefined {
  if (!inputId) return undefined;
  return manifest?.inputs.find((input) => input.id === inputId);
}

function pendingFormForIntervention(
  intervention: InterventionRequest | undefined,
): PendingFormRequest | undefined {
  if (!intervention || intervention.status === "resolved") return undefined;
  return {
    id: intervention.id,
    title: intervention.title ?? "Needs Human Input",
    description: intervention.description,
    schema: intervention.schema,
    action: intervention.action,
    actionUrl: intervention.actionUrl,
  };
}

function immediateInputNeedsForm(
  manifest: WorkflowManifest | undefined,
  nodeId: string | null,
  runState: RunState | undefined,
): boolean {
  if (!nodeId) return false;
  const def =
    findManifestInput(manifest, nodeId) ?? globalRegistry.getInput(nodeId);
  if (!def || def.kind !== "input" || def.secret) return false;
  return !runState?.nodes[nodeId];
}

function pendingInputNeedsForm(
  manifest: WorkflowManifest | undefined,
  runState: RunState | undefined,
  nodeId: string | null,
): boolean {
  if (!nodeId || !runState) return false;
  const def =
    findManifestInput(manifest, nodeId) ?? globalRegistry.getInput(nodeId);
  if (!def) return false;
  if (runState.nodes[nodeId]?.status === "resolved") return false;
  return workflowInputRequested(globalRegistry, manifest, runState, nodeId);
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
  path: PropertyKey[];
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

function newRunId(): string {
  const id =
    globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `run_${id}`;
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
        <div className="grid content-start gap-3 border-border border-b pb-4 lg:border-r lg:border-b-0 lg:pr-4 lg:pb-0">
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
              Secret
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
            <Select
              value={scope}
              onValueChange={(value) =>
                setScope(value === "organization" ? "organization" : "user")
              }
            >
              <SelectTrigger id="vault-scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="user">User</SelectItem>
                <SelectItem value="organization">Organization</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button
            type="button"
            onClick={() => void createSecret()}
            disabled={vault.isPending}
          >
            <Plus className="size-4" aria-hidden />
            Add Secret
          </Button>
          {formError || vault.error ? (
            <p className="text-destructive text-xs">
              {formError ?? vault.error?.message}
            </p>
          ) : null}
        </div>

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
  sidebarFooter,
  sidebarHeader,
  sidebarTopInset,
}: {
  workflowId: string;
  runId?: string;
  navigation?: WorkflowNavigation;
  sidebarFooter?: ReactNode;
  sidebarHeader?: ReactNode;
  sidebarTopInset?: number | string;
}) {
  return (
    <WorkflowRunProvider runId={runId}>
      <WorkflowRunnerBody
        workflowId={workflowId}
        runId={runId}
        navigation={navigation}
        sidebarFooter={sidebarFooter}
        sidebarHeader={sidebarHeader}
        sidebarTopInset={sidebarTopInset}
      />
    </WorkflowRunProvider>
  );
}

function WorkflowRunnerBody({
  workflowId,
  runId,
  navigation,
  sidebarFooter,
  sidebarHeader,
  sidebarTopInset,
}: {
  workflowId: string;
  runId?: string;
  navigation: WorkflowNavigation;
  sidebarFooter?: ReactNode;
  sidebarHeader?: ReactNode;
  sidebarTopInset?: number | string;
}) {
  const workflow = useWorkflow(workflowId);
  const workflowRun = useWorkflowRun();

  const [pane, setPane] = useState<SidePane>(null);
  const [inputValues, setInputValues] = useState<Record<string, unknown>>(() =>
    buildInitialManifestInputValues(undefined),
  );
  const [payloadError, setPayloadError] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [connectingManagedConnectionId, setConnectingManagedConnectionId] =
    useState<string | undefined>();
  const [clearingManagedConnectionId, setClearingManagedConnectionId] =
    useState<string | undefined>();
  const [awaitingManagedConnectionId, setAwaitingManagedConnectionId] =
    useState<string | undefined>();
  const managedConnectionPopups = useRef<Record<string, Window | null>>({});
  const frontendConfig = useWorkflowFrontendConfig();

  const {
    isRunning,
    setRunning,
    executingNodeId,
    setExecutingNodeId,
    runComplete,
    runState,
  } = workflowRun;
  const wait = findPendingWait(workflow.manifest, runState);
  const pendingInputId = wait?.kind === "input" ? wait.inputId : undefined;
  const pendingInterventionId =
    wait?.kind === "intervention" ? wait.interventionId : undefined;
  const pendingInput = findManifestInput(workflow.manifest, pendingInputId);
  const pendingIntervention = pendingInterventionId
    ? runState?.interventions?.[pendingInterventionId]
    : undefined;
  const pendingRequest =
    pendingFormForIntervention(pendingIntervention) ?? pendingInput;

  const nodes = runState?.nodes ?? {};
  const isPending = workflow.isPending || workflowRun.isPending;
  const managedConnectionStates = buildManagedConnectionStates(
    workflow.configuration,
  );

  const reserveManagedConnectionPopup = useCallback(
    (connectionId: string) => {
      const popup = window.open(
        frontendConfig.managedConnectionInitializingUrl,
        "_blank",
      );
      managedConnectionPopups.current[connectionId] = popup;
    },
    [frontendConfig.managedConnectionInitializingUrl],
  );

  const closeManagedConnectionPopup = useCallback((connectionId: string) => {
    const popup = managedConnectionPopups.current[connectionId];
    delete managedConnectionPopups.current[connectionId];
    if (!popup || popup.closed) return;
    popup.close();
  }, []);

  const openManagedConnectionUrl = useCallback(
    (connectionId: string, url: string) => {
      const popup = managedConnectionPopups.current[connectionId];
      delete managedConnectionPopups.current[connectionId];
      if (popup && !popup.closed) {
        popup.location.href = url;
        popup.focus();
        return;
      }
      window.open(url, "_blank", "noopener,noreferrer");
    },
    [],
  );

  useEffect(() => {
    if (!workflow.manifest) return;
    setInputValues((current) => ({
      ...buildInitialManifestInputValues(workflow.manifest),
      ...current,
    }));
  }, [workflow.manifest]);

  useEffect(() => {
    const request = pendingFormForIntervention(pendingIntervention);
    if (!request) return;
    setInputValues((current) => {
      if (request.id in current) return current;
      return {
        ...current,
        [request.id]: defaultForJsonSchema(request.schema),
      };
    });
  }, [pendingIntervention]);

  useEffect(() => {
    if (!awaitingManagedConnectionId) return;
    const interventionId = `${awaitingManagedConnectionId}:oauth-callback`;
    const intervention =
      workflow.configuration?.run?.state.interventions?.[interventionId];
    const connection = workflow.configuration?.connections.find(
      (candidate) => candidate.id === awaitingManagedConnectionId,
    );

    if (intervention && intervention.status !== "resolved") {
      const url =
        intervention.actionUrl ??
        (intervention.action?.type === "open_url"
          ? intervention.action.url
          : undefined);
      if (url) {
        openManagedConnectionUrl(awaitingManagedConnectionId, url);
        setConnectingManagedConnectionId(undefined);
        setAwaitingManagedConnectionId(undefined);
      }
      return;
    }

    if (connection?.status === "connected" || connection?.status === "error") {
      closeManagedConnectionPopup(awaitingManagedConnectionId);
      setConnectingManagedConnectionId(undefined);
      setAwaitingManagedConnectionId(undefined);
    }
  }, [
    awaitingManagedConnectionId,
    closeManagedConnectionPopup,
    openManagedConnectionUrl,
    workflow.configuration,
  ]);

  useEffect(() => {
    if (!awaitingManagedConnectionId) return;
    const interventionId = `${awaitingManagedConnectionId}:oauth-callback`;
    const intervention =
      workflow.configuration?.run?.state.interventions?.[interventionId];
    const connection = workflow.configuration?.connections.find(
      (candidate) => candidate.id === awaitingManagedConnectionId,
    );
    const actionUrl =
      intervention?.actionUrl ??
      (intervention?.action?.type === "open_url"
        ? intervention.action.url
        : undefined);
    if (
      actionUrl ||
      connection?.status === "connected" ||
      connection?.status === "error"
    ) {
      return;
    }

    const timeout = window.setTimeout(() => {
      void workflow.refreshConfiguration();
    }, 500);
    return () => window.clearTimeout(timeout);
  }, [awaitingManagedConnectionId, workflow]);

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
    setConnectingManagedConnectionId(undefined);
    setClearingManagedConnectionId(undefined);
    setAwaitingManagedConnectionId(undefined);
    setInputValues(buildInitialManifestInputValues(workflow.manifest));
    setPayloadError("");
    setPane(null);
    navigation.workflow(workflowId);
  }

  function runWorkflow(seedOverride?: string) {
    setPayloadError("");
    const seed = seedOverride
      ? findManifestInput(workflow.manifest, seedOverride)
      : undefined;
    const args: Parameters<typeof workflow.start>[0] = {};

    if (seedOverride) {
      if (!seed) {
        setPayloadError(`No input named "${seedOverride}" is registered.`);
        return;
      }

      try {
        args.inputId = seed.id;
        args.payload = sanitizeJsonSchemaValue(
          seed.schema,
          inputValues[seed.id],
        );
      } catch (e) {
        setPayloadError(
          errorMessage(e, "Validation failed for the initial inputs."),
        );
        return;
      }
    }

    try {
      const runId = newRunId();
      void workflow
        .start({
          ...args,
          runId,
        })
        .catch((e) => {
          setPayloadError(
            errorMessage(e, "Processing failed — check input values."),
          );
        });
      navigation.run(workflowId, runId);
      setPane(null);
    } catch (e) {
      setPayloadError(
        errorMessage(e, "Processing failed — check input values."),
      );
    }
  }

  async function connectManagedConnection(
    connectionId: string,
    options?: { restart?: boolean },
  ) {
    setPayloadError("");
    const restart = options?.restart === true;
    const existingActionUrl = managedConnectionStates[connectionId]?.actionUrl;
    if (existingActionUrl && !restart) {
      window.open(existingActionUrl, "_blank", "noopener,noreferrer");
      return;
    }
    reserveManagedConnectionPopup(connectionId);
    setConnectingManagedConnectionId(connectionId);
    setAwaitingManagedConnectionId(connectionId);

    try {
      const result = await workflow.connectManagedConnection(connectionId, {
        restart,
      });
      const intervention =
        result.run?.state.interventions?.[`${connectionId}:oauth-callback`];
      if (intervention && intervention.status !== "resolved") {
        const url =
          intervention.actionUrl ??
          (intervention.action?.type === "open_url"
            ? intervention.action.url
            : undefined);
        if (url) {
          openManagedConnectionUrl(connectionId, url);
          setConnectingManagedConnectionId(undefined);
          setAwaitingManagedConnectionId(undefined);
        }
      }
      const connection = result.connections.find(
        (candidate) => candidate.id === connectionId,
      );
      if (
        connection?.status === "connected" ||
        connection?.status === "error"
      ) {
        closeManagedConnectionPopup(connectionId);
        setConnectingManagedConnectionId(undefined);
        setAwaitingManagedConnectionId(undefined);
      }
    } catch (e) {
      closeManagedConnectionPopup(connectionId);
      setConnectingManagedConnectionId(undefined);
      setAwaitingManagedConnectionId(undefined);
      setPayloadError(
        errorMessage(e, "Unable to start managed connection authorization."),
      );
    }
  }

  async function clearManagedConnection(connectionId: string) {
    setPayloadError("");
    setClearingManagedConnectionId(connectionId);
    setAwaitingManagedConnectionId(undefined);

    try {
      await workflow.clearManagedConnection(connectionId);
    } catch (e) {
      setPayloadError(
        errorMessage(e, "Unable to clear managed connection authorization."),
      );
    } finally {
      setClearingManagedConnectionId(undefined);
    }
  }

  async function submitPendingInput(explicitInputId?: string) {
    const inputId = explicitInputId ?? pendingInputId;
    if (!inputId) return;
    const explicitRequestedInput =
      Boolean(explicitInputId) &&
      runState &&
      workflowInputRequested(
        globalRegistry,
        workflow.manifest,
        runState,
        inputId,
      );
    if (!explicitRequestedInput && inputId !== pendingInputId) {
      setPayloadError(
        `This run is waiting on "${pendingInputId ?? pendingInterventionId ?? "—"}", not "${inputId}".`,
      );
      return;
    }
    const def = findManifestInput(workflow.manifest, inputId);
    if (!def) return;

    if (def.secret) {
      setPayloadError(
        def.errorMessage ??
          `"${inputId}" is a secret and must be resolved in the workflow server.`,
      );
      return;
    }

    setPayloadError("");
    let payload: unknown;
    try {
      payload = sanitizeJsonSchemaValue(def.schema, inputValues[inputId]);
    } catch (e) {
      setPayloadError(errorMessage(e, `Validation failed for "${inputId}".`));
      return;
    }

    setRunning(true);
    setExecutingNodeId(inputId);
    try {
      await workflowRun.submitInput({
        state: runState,
        inputId,
        payload,
      });
      setPane(null);
    } catch (e) {
      setRunning(false);
      setPayloadError(
        errorMessage(e, "Processing failed — check input values."),
      );
    } finally {
      setExecutingNodeId(null);
    }
  }

  async function submitPendingIntervention() {
    if (!pendingInterventionId) return;
    const request = pendingFormForIntervention(pendingIntervention);
    if (!request) return;

    setPayloadError("");
    let payload: unknown;
    try {
      payload = sanitizeJsonSchemaValue(
        request.schema,
        inputValues[pendingInterventionId],
      );
    } catch (e) {
      setPayloadError(
        errorMessage(e, `Validation failed for "${pendingInterventionId}".`),
      );
      return;
    }

    setRunning(true);
    try {
      await workflowRun.submitIntervention({
        state: runState,
        interventionId: pendingInterventionId,
        payload,
      });
      setPane(null);
    } catch (e) {
      setRunning(false);
      setPayloadError(
        errorMessage(e, "Processing failed — check input values."),
      );
    }
  }

  function toggleRunning() {
    setPayloadError("");
    setRunning(!isRunning);
  }

  const selectedRecord = displayNodeRecord(
    globalRegistry,
    selectedNodeId,
    selectedNodeId ? nodes[selectedNodeId] : undefined,
  );

  const selectedInterventions: NodeIntervention[] = selectedNodeId
    ? Object.values(runState?.interventions ?? {})
        .filter((request) => request.stepId === selectedNodeId)
        .map((request) => ({
          request,
          response: runState?.inputs?.[request.id],
        }))
    : [];

  let nodeEditor: NodeDetailEditor | null = null;
  if (selectedNodeId) {
    const def = findManifestInput(workflow.manifest, selectedNodeId);
    const selectedValue = inputValues[selectedNodeId];
    if (
      def &&
      immediateInputNeedsForm(workflow.manifest, selectedNodeId, runState)
    ) {
      nodeEditor = {
        inputDescription: def.description,
        description:
          "Submit this payload as the seed input event (same as Start Workflow).",
        schema: def.schema,
        secret: def.secret,
        value: selectedValue,
        onChange: (v) => setInputValue(selectedNodeId, v),
        onSubmit: () => void runWorkflow(selectedNodeId),
        submitLabel: workflowInputLabel(def, selectedNodeId),
        error: payloadError || undefined,
      };
    } else if (
      def &&
      !def.secret &&
      pendingInputNeedsForm(workflow.manifest, runState, selectedNodeId)
    ) {
      const id = selectedNodeId;
      nodeEditor = {
        inputDescription: def.description,
        description:
          "Input required by a waiting step. Submit it to continue this run.",
        schema: def.schema,
        value: selectedValue,
        onChange: (v) => setInputValue(id, v),
        onSubmit: () => void submitPendingInput(id),
        submitLabel: workflowInputLabel(def, id),
        error: payloadError || undefined,
      };
    }
  }

  if (workflow.manifestNotFound) {
    return <NotFoundScreen workflowId={workflowId} navigation={navigation} />;
  }

  return (
    <div className="flex h-screen min-h-0 bg-background">
      <aside
        className="flex w-48 shrink-0 flex-col bg-off-black text-off-white sm:w-64 lg:w-72"
        style={sidebarTopInset ? { paddingTop: sidebarTopInset } : undefined}
      >
        <div className="flex shrink-0 flex-col gap-1 px-2.5 pt-2.5 pb-2">
          {sidebarHeader ?? (
            <button
              type="button"
              onClick={() => navigation.home()}
              className="truncate rounded-sm text-left text-sm font-semibold tracking-tight outline-none hover:text-off-white/80 focus-visible:ring-3 focus-visible:ring-off-white/30 md:text-base"
            >
              {workflow.manifest?.name ?? "Workflow"}
            </button>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {workflow.isLoadingRuns ? (
            <div className="px-2 py-3 text-xs text-muted-foreground">
              Loading…
            </div>
          ) : workflow.runs.length === 0 ? (
            <div className="px-2 py-3 text-xs text-muted-foreground">
              No runs
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              {workflow.runs.map((run) => {
                const active = run.runId === runId;
                const runTitle = workflowInputLabel(
                  findManifestInput(workflow.manifest, run.triggerInputId),
                  run.triggerInputId,
                );
                return (
                  <button
                    key={run.runId}
                    type="button"
                    onClick={() => navigation.run(workflowId, run.runId)}
                    disabled={isPending}
                    aria-current={active ? "true" : undefined}
                    aria-label={`${runTitle}, ${runStatusLabel(run.status)}, ${formatRunTime(run.startedAt)}`}
                    className={cn(
                      "grid min-h-20 w-full grid-cols-[auto_minmax(0,1fr)] gap-x-2 rounded-lg px-2.5 py-2 text-left text-sm outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-3 focus-visible:ring-sidebar-ring/50 disabled:pointer-events-none disabled:opacity-60",
                      active &&
                        "bg-sidebar-accent text-sidebar-accent-foreground shadow-sm",
                    )}
                  >
                    <span
                      className={cn(
                        "mt-1 size-2 rounded-full",
                        runStatusClass(run.status),
                      )}
                      title={runStatusLabel(run.status)}
                      aria-hidden
                    />
                    <span className="min-w-0">
                      <span className="block min-w-0 truncate font-medium">
                        {runTitle}
                      </span>
                      <span className="mt-1 flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                        <Clock3 className="size-3 shrink-0" aria-hidden />
                        <span className="min-w-0 truncate">
                          {formatRunTime(run.startedAt)}
                        </span>
                        <span aria-hidden>·</span>
                        <span className="shrink-0">
                          {runStatusLabel(run.status)}
                        </span>
                      </span>
                      {run.waitingOn.length > 0 && (
                        <span className="mt-1 block truncate text-xs text-muted-foreground">
                          Waiting on{" "}
                          {run.waitingOn
                            .map((inputId) =>
                              workflowInputLabel(
                                findManifestInput(workflow.manifest, inputId),
                                inputId,
                              ),
                            )
                            .join(", ")}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        {sidebarFooter ? (
          <div className="shrink-0 p-2">{sidebarFooter}</div>
        ) : null}
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-10 flex-wrap items-center justify-end gap-2 border-b border-border px-3 py-2">
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
            {runComplete ? (
              <div
                role="status"
                aria-label="Run complete"
                className="inline-flex h-7 cursor-default items-center gap-1.5 rounded-lg border border-emerald-600/45 bg-emerald-600/12 px-2.5 text-[0.8rem] font-medium text-emerald-900 dark:border-emerald-500/40 dark:bg-emerald-500/14 dark:text-emerald-50"
              >
                <Check className="size-3.5 shrink-0 stroke-[2.5]" aria-hidden />
                Run complete
              </div>
            ) : runState ? (
              <Button
                size="sm"
                variant={isRunning ? "default" : "outline"}
                aria-pressed={isRunning}
                onClick={toggleRunning}
                disabled={isRunning}
                title={
                  isRunning
                    ? "Advancing the workflow"
                    : "Advance the workflow until it completes or needs input"
                }
              >
                {isRunning ? (
                  <>
                    <Loader2
                      className="size-3.5 shrink-0 animate-spin"
                      aria-hidden
                    />
                    Running
                  </>
                ) : (
                  "Next"
                )}
              </Button>
            ) : null}
          </div>
        </header>

        <div className="relative flex min-h-0 flex-1">
          <QueueVisualizer
            runState={runState}
            queue={workflowRun.queue}
            registry={globalRegistry}
            manifest={workflow.manifest}
            executingNodeId={executingNodeId}
            onNodeClick={(id) => {
              const rec = runState?.nodes[id];
              const waitingOn = rec?.waitingOn;
              const intervention = waitingOn
                ? runState?.interventions?.[waitingOn]
                : undefined;
              if (
                rec?.status === "waiting" &&
                intervention &&
                intervention.status !== "resolved"
              ) {
                setPane("pending");
                return;
              }
              setSelectedNodeId(id);
            }}
          />

          {runId && isPending && !runState ? (
            <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center bg-background/85 p-6 text-center backdrop-blur-sm">
              <div className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground shadow-sm">
                <Loader2 className="size-4 animate-spin" aria-hidden />
                Loading run…
              </div>
            </div>
          ) : null}

          {!runState && !runId && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-start justify-center overflow-y-auto p-6 md:items-center">
              <div className="pointer-events-auto flex w-full max-w-lg flex-col gap-4">
                <StartWorkflowForm
                  inputs={workflow.manifest?.inputs ?? []}
                  managedConnections={
                    workflow.manifest?.managedConnections ?? []
                  }
                  managedConnectionStates={managedConnectionStates}
                  inputValues={inputValues}
                  onInputValuesChange={setInputValue}
                  canSubmitSeed={!runState && !runId}
                  onSubmitSeed={(inputId) => void runWorkflow(inputId)}
                  onConnectManagedConnection={(connectionId, options) =>
                    void connectManagedConnection(connectionId, options)
                  }
                  onClearManagedConnection={(connectionId) =>
                    void clearManagedConnection(connectionId)
                  }
                  connectingManagedConnectionId={connectingManagedConnectionId}
                  clearingManagedConnectionId={clearingManagedConnectionId}
                  error={payloadError || undefined}
                  starting={workflow.isPending}
                />
                <SchedulesPanel
                  schedules={workflow.manifest?.schedules ?? []}
                  runs={workflow.runs}
                  runScheduleNow={(id) => void workflow.runScheduleNow(id)}
                  runningScheduleId={workflow.runningScheduleId}
                />
              </div>
            </div>
          )}

          <RunStateJsonSheet
            open={pane === "state"}
            onOpenChange={(o) => setPane(o ? "state" : null)}
            runState={runState}
            registry={globalRegistry}
          />

          <PendingInputSheet
            open={pane === "pending" && Boolean(pendingRequest)}
            onOpenChange={(o) => setPane(o ? "pending" : null)}
            input={pendingRequest}
            inputValues={inputValues}
            onInputValuesChange={setInputValue}
            onSubmit={() =>
              pendingInterventionId
                ? void submitPendingIntervention()
                : void submitPendingInput()
            }
            error={pane === "pending" ? payloadError || undefined : undefined}
          />

          <NodeDetailSheet
            nodeId={selectedNodeId}
            record={selectedRecord}
            editor={nodeEditor}
            interventions={selectedInterventions}
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

function buildManagedConnectionStates(
  configuration: WorkflowConfigurationDocument | undefined,
): Record<string, ManagedConnectionDisplayState> {
  const states: Record<string, ManagedConnectionDisplayState> = {};
  for (const connection of configuration?.connections ?? []) {
    const intervention =
      configuration?.run?.state.interventions?.[
        `${connection.id}:oauth-callback`
      ];
    const actionUrl =
      intervention?.actionUrl ??
      (intervention?.action?.type === "open_url"
        ? intervention.action.url
        : undefined);
    states[connection.id] = {
      status: connection.status,
      waitingOn: connection.waitingOn,
      actionUrl,
    };
  }
  return states;
}

export function WorkflowSingleApp({
  sidebarFooter,
  runId: controlledRunId,
  navigation,
  sidebarHeader,
  sidebarTopInset,
}: {
  sidebarFooter?: ReactNode;
  runId?: string;
  navigation?: WorkflowNavigation;
  sidebarHeader?: ReactNode;
  sidebarTopInset?: number | string;
} = {}) {
  const workflow = useWorkflow(undefined);
  const [internalRunId, setRunId] = useState<string | undefined>();
  const manifest = workflow.manifest;
  const runId = controlledRunId ?? internalRunId;

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

  const resolvedNavigation: WorkflowNavigation = navigation ?? {
    home: () => setRunId(undefined),
    workflow: () => setRunId(undefined),
    run: (_workflowId, nextRunId) => setRunId(nextRunId),
  };

  return (
    <WorkflowRunnerApp
      workflowId={manifest.workflowId}
      runId={runId}
      navigation={resolvedNavigation}
      sidebarFooter={sidebarFooter}
      sidebarHeader={sidebarHeader}
      sidebarTopInset={sidebarTopInset}
    />
  );
}

export function WorkflowSinglePage({
  apiBaseUrl = "/api/workflow",
  managedConnectionInitializingUrl,
  sidebarFooter,
  runId,
  navigation,
  sidebarHeader,
  sidebarTopInset,
}: {
  apiBaseUrl?: string;
  managedConnectionInitializingUrl?: string;
  sidebarFooter?: ReactNode;
  runId?: string;
  navigation?: WorkflowNavigation;
  sidebarHeader?: ReactNode;
  sidebarTopInset?: number | string;
}) {
  return (
    <WorkflowFrontendRoot
      config={{ apiBaseUrl, managedConnectionInitializingUrl }}
    >
      <WorkflowSingleApp
        sidebarFooter={sidebarFooter}
        runId={runId}
        navigation={navigation}
        sidebarHeader={sidebarHeader}
        sidebarTopInset={sidebarTopInset}
      />
    </WorkflowFrontendRoot>
  );
}
