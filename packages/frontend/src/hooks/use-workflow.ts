import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RunState } from "@workflow/core";
import type { QueueSnapshot, RunEvent, RunSnapshot } from "@workflow/runtime";
import { useCallback, useMemo, useState } from "react";
import { useWorkflowFrontendConfig } from "../config";
import type {
  AdvanceWorkflowArgs,
  SubmitWorkflowInputArgs,
  SubmitWorkflowInterventionArgs,
} from "../lib/workflow-runtimes";
import type {
  BindRunSecretRequest,
  CreateSecretVaultEntryRequest,
  JsonPayload,
  RunStateDocument,
  RunSummary,
  SecretVaultEntry,
  StartWorkflowRunRequest,
  SubmitBackendInputRequest,
  SubmitBackendInterventionRequest,
  WorkflowManifest,
  WorkflowRuntimeResult,
} from "../types";

export type StartRunArgs = {
  inputId: string;
  payload: unknown;
  additionalInputs?: {
    inputId: string;
    payload: unknown;
  }[];
  secretBindings?: Record<string, string | { vaultEntryId: string }>;
  secretValues?: Record<string, string>;
};

export type WorkflowState = {
  manifest: WorkflowManifest | undefined;
  manifestNotFound: boolean;
  runs: RunSummary[];
  isPending: boolean;
  error: Error | undefined;
  start(args: StartRunArgs): Promise<WorkflowRuntimeResult>;
  refreshRuns(): Promise<void>;
};

export type WorkflowRunState = {
  runState: RunState | undefined;
  snapshot: RunSnapshot | undefined;
  queue: QueueSnapshot | undefined;
  events: RunEvent[];
  workflowId: string | undefined;
  isPending: boolean;
  error: Error | undefined;
  submitInput(args: SubmitWorkflowInputArgs): Promise<WorkflowRuntimeResult>;
  submitIntervention(
    args: SubmitWorkflowInterventionArgs,
  ): Promise<WorkflowRuntimeResult>;
  advance(args: AdvanceWorkflowArgs): Promise<WorkflowRuntimeResult>;
  bindSecret(args: BindRunSecretArgs): Promise<WorkflowRuntimeResult>;
  clear(): void;
};

export type BindRunSecretArgs = {
  state?: RunState;
  logicalName: string;
  vaultEntryId: string;
};

export type SecretVaultState = {
  entries: SecretVaultEntry[];
  isPending: boolean;
  error: Error | undefined;
  create(args: CreateSecretVaultEntryRequest): Promise<SecretVaultEntry>;
  deleteEntry(secretId: string): Promise<void>;
  refresh(): Promise<void>;
};

const queryKeys = {
  workflow: (apiBaseUrl: string) =>
    ["workflow-frontend", apiBaseUrl, "workflow"] as const,
  runs: (apiBaseUrl: string) =>
    ["workflow-frontend", apiBaseUrl, "runs"] as const,
  runState: (apiBaseUrl: string, runId: string) =>
    ["workflow-frontend", apiBaseUrl, "run-state", runId] as const,
  vault: (apiBaseUrl: string) =>
    ["workflow-frontend", apiBaseUrl, "vault"] as const,
};

function useWorkflowManifestQuery() {
  const config = useWorkflowFrontendConfig();
  return useQuery({
    queryKey: queryKeys.workflow(config.apiBaseUrl),
    retry: false,
    queryFn: () => apiGet<WorkflowManifest>(config.apiBaseUrl, "/manifest"),
  });
}

function useRunsQuery() {
  const config = useWorkflowFrontendConfig();
  return useQuery({
    queryKey: queryKeys.runs(config.apiBaseUrl),
    refetchInterval: 500,
    queryFn: () => apiGet<RunSummary[]>(config.apiBaseUrl, "/runs"),
  });
}

function useRunStateQuery(runId: string | undefined) {
  const config = useWorkflowFrontendConfig();
  return useQuery({
    queryKey: runId
      ? queryKeys.runState(config.apiBaseUrl, runId)
      : ["workflow-frontend", config.apiBaseUrl, "run-state", "none"],
    enabled: Boolean(runId),
    refetchInterval: 500,
    queryFn: async () => {
      if (!runId) throw new Error("Cannot poll before a run exists.");
      return documentResult(
        await apiGet<RunStateDocument>(
          config.apiBaseUrl,
          `/state/${encodeURIComponent(runId)}`,
        ),
      );
    },
  });
}

function useStartWorkflowRunMutation() {
  const config = useWorkflowFrontendConfig();
  return useMutation({
    mutationFn: async (args: StartRunArgs) => {
      const body: StartWorkflowRunRequest = {
        inputId: args.inputId,
        payload: args.payload as JsonPayload,
        additionalInputs: args.additionalInputs as
          | { inputId: string; payload: JsonPayload }[]
          | undefined,
        secretBindings: args.secretBindings,
        secretValues: args.secretValues,
      };
      return documentResult(
        await apiPost<StartWorkflowRunRequest, RunStateDocument>(
          config.apiBaseUrl,
          "/runs",
          body,
        ),
      );
    },
  });
}

function useSecretVaultQuery() {
  const config = useWorkflowFrontendConfig();
  return useQuery({
    queryKey: queryKeys.vault(config.apiBaseUrl),
    enabled: false,
    queryFn: () =>
      apiGet<SecretVaultEntry[]>(config.apiBaseUrl, "/vault/secrets"),
  });
}

function useCreateSecretVaultEntryMutation() {
  return useMutation({
    mutationFn: (_args: CreateSecretVaultEntryRequest) =>
      Promise.reject(
        new Error("This workflow server does not support secret vaults."),
      ),
  });
}

function useDeleteSecretVaultEntryMutation() {
  return useMutation({
    mutationFn: async (_secretId: string) => {
      throw new Error("This workflow server does not support secret vaults.");
    },
  });
}

function useBindRunSecretMutation() {
  const config = useWorkflowFrontendConfig();
  return useMutation({
    mutationFn: async (args: BindRunSecretArgs) => {
      if (!args.state)
        throw new Error("Cannot bind a secret before a run exists.");
      const body: BindRunSecretRequest = {
        vaultEntryId: args.vaultEntryId,
      };
      return documentResult(
        await apiPut<BindRunSecretRequest, RunStateDocument>(
          config.apiBaseUrl,
          `/runs/${encodeURIComponent(args.state.runId)}/secret-bindings/${encodeURIComponent(args.logicalName)}`,
          body,
        ),
      );
    },
  });
}

function useSubmitInputMutation() {
  const config = useWorkflowFrontendConfig();
  return useMutation({
    mutationFn: async (args: SubmitWorkflowInputArgs) => {
      if (!args.state)
        throw new Error("Cannot submit input before a run exists.");

      const body: SubmitBackendInputRequest = {
        inputId: args.inputId,
        payload: args.payload as JsonPayload,
        secretValues: args.secretValues,
      };
      return documentResult(
        await apiPost<SubmitBackendInputRequest, RunStateDocument>(
          config.apiBaseUrl,
          `/runs/${encodeURIComponent(args.state.runId)}/inputs`,
          body,
        ),
      );
    },
  });
}

function useSubmitInterventionMutation() {
  const config = useWorkflowFrontendConfig();
  return useMutation({
    mutationFn: async (args: SubmitWorkflowInterventionArgs) => {
      if (!args.state)
        throw new Error("Cannot submit intervention before a run exists.");

      const body: SubmitBackendInterventionRequest = {
        payload: args.payload as JsonPayload,
        secretValues: args.secretValues,
      };
      return documentResult(
        await apiPost<SubmitBackendInterventionRequest, RunStateDocument>(
          config.apiBaseUrl,
          `/runs/${encodeURIComponent(args.state.runId)}/interventions/${encodeURIComponent(args.interventionId)}`,
          body,
        ),
      );
    },
  });
}

function useAdvanceRunMutation() {
  const config = useWorkflowFrontendConfig();
  return useMutation({
    mutationFn: async (args: AdvanceWorkflowArgs) => {
      if (!args.state) throw new Error("Cannot advance before a run exists.");

      return documentResult(
        await apiPost<
          { secretValues?: Record<string, string> },
          RunStateDocument
        >(
          config.apiBaseUrl,
          `/runs/${encodeURIComponent(args.state.runId)}/advance`,
          { secretValues: args.secretValues },
        ),
      );
    },
  });
}

export function useSecretVault(): SecretVaultState {
  const config = useWorkflowFrontendConfig();
  const queryClient = useQueryClient();
  const vaultQuery = useSecretVaultQuery();
  const createMutation = useCreateSecretVaultEntryMutation();
  const deleteMutation = useDeleteSecretVaultEntryMutation();
  const [error, setError] = useState<Error | undefined>();

  const refresh = useCallback(async () => {
    try {
      const result = await vaultQuery.refetch();
      if (result.error) {
        setError(normalizeError(result.error));
      }
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    }
  }, [vaultQuery]);

  const create = useCallback(
    async (args: CreateSecretVaultEntryRequest) => {
      setError(undefined);
      try {
        const entry = await createMutation.mutateAsync(args);
        await queryClient.invalidateQueries({
          queryKey: queryKeys.vault(config.apiBaseUrl),
        });
        return entry;
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        setError(err);
        throw err;
      }
    },
    [config.apiBaseUrl, createMutation, queryClient],
  );

  const deleteEntry = useCallback(
    async (secretId: string) => {
      setError(undefined);
      try {
        await deleteMutation.mutateAsync(secretId);
        await queryClient.invalidateQueries({
          queryKey: queryKeys.vault(config.apiBaseUrl),
        });
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        setError(err);
        throw err;
      }
    },
    [config.apiBaseUrl, deleteMutation, queryClient],
  );

  return {
    entries: vaultQuery.data ?? [],
    isPending:
      vaultQuery.isPending ||
      createMutation.isPending ||
      deleteMutation.isPending,
    error: error ?? normalizeError(vaultQuery.error),
    create,
    deleteEntry,
    refresh,
  };
}

export function useWorkflow(workflowId: string | undefined): WorkflowState {
  const config = useWorkflowFrontendConfig();
  const queryClient = useQueryClient();
  const manifestQuery = useWorkflowManifestQuery();
  const runsQuery = useRunsQuery();
  const startMutation = useStartWorkflowRunMutation();
  const [error, setError] = useState<Error | undefined>();

  const manifest =
    workflowId &&
    manifestQuery.data &&
    manifestQuery.data.workflowId !== workflowId
      ? undefined
      : manifestQuery.data;
  const runs = runsQuery.data ?? [];

  const start = useCallback(
    async (args: StartRunArgs) => {
      setError(undefined);
      try {
        const result = await startMutation.mutateAsync(args);
        queryClient.setQueryData(
          queryKeys.runState(config.apiBaseUrl, result.state.runId),
          result,
        );
        queryClient.setQueryData(
          queryKeys.runs(config.apiBaseUrl),
          (existing: RunSummary[] = []) =>
            mergeRunSummary(existing, summarizeRunResult(result)),
        );
        await queryClient.invalidateQueries({
          queryKey: queryKeys.runs(config.apiBaseUrl),
        });
        return result;
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        setError(err);
        throw err;
      }
    },
    [config.apiBaseUrl, queryClient, startMutation],
  );

  const refreshRuns = useCallback(async () => {
    try {
      const result = await runsQuery.refetch();
      if (result.error) {
        setError(
          result.error instanceof Error
            ? result.error
            : new Error(String(result.error)),
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    }
  }, [runsQuery]);

  const isPending = manifestQuery.isPending || startMutation.isPending;

  const activeError =
    error ?? normalizeError(manifestQuery.error ?? runsQuery.error);

  const manifestNotFound =
    !manifestQuery.isPending && (!manifest || Boolean(manifestQuery.error));

  return {
    manifest,
    manifestNotFound,
    runs,
    isPending,
    error: activeError,
    start,
    refreshRuns,
  };
}

export function useWorkflowRun(runId: string | undefined): WorkflowRunState {
  const config = useWorkflowFrontendConfig();
  const queryClient = useQueryClient();
  const stateQuery = useRunStateQuery(runId);
  const submitInputMutation = useSubmitInputMutation();
  const submitInterventionMutation = useSubmitInterventionMutation();
  const advanceMutation = useAdvanceRunMutation();
  const bindSecretMutation = useBindRunSecretMutation();
  const [error, setError] = useState<Error | undefined>();

  const cacheResult = useCallback(
    (result: WorkflowRuntimeResult) => {
      queryClient.setQueryData(
        queryKeys.runState(config.apiBaseUrl, result.state.runId),
        result,
      );
      queryClient.setQueryData(
        queryKeys.runs(config.apiBaseUrl),
        (existing: RunSummary[] = []) =>
          mergeRunSummary(existing, summarizeRunResult(result)),
      );
    },
    [config.apiBaseUrl, queryClient],
  );

  const runMutation = useCallback(
    async <TArgs>(
      mutation: {
        mutateAsync(args: TArgs): Promise<WorkflowRuntimeResult>;
      },
      args: TArgs,
    ) => {
      setError(undefined);
      try {
        const result = await mutation.mutateAsync(args);
        cacheResult(result);
        await queryClient.invalidateQueries({
          queryKey: queryKeys.runs(config.apiBaseUrl),
        });
        return result;
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        setError(err);
        throw err;
      }
    },
    [cacheResult, config.apiBaseUrl, queryClient],
  );

  const submitInput = useCallback(
    (args: SubmitWorkflowInputArgs) => runMutation(submitInputMutation, args),
    [runMutation, submitInputMutation],
  );

  const submitIntervention = useCallback(
    (args: SubmitWorkflowInterventionArgs) =>
      runMutation(submitInterventionMutation, args),
    [runMutation, submitInterventionMutation],
  );

  const advance = useCallback(
    (args: AdvanceWorkflowArgs) => runMutation(advanceMutation, args),
    [advanceMutation, runMutation],
  );

  const bindSecret = useCallback(
    (args: BindRunSecretArgs) => runMutation(bindSecretMutation, args),
    [bindSecretMutation, runMutation],
  );

  const clear = useCallback(() => {
    setError(undefined);
  }, []);

  const isPending = useMemo(
    () =>
      submitInputMutation.isPending ||
      submitInterventionMutation.isPending ||
      advanceMutation.isPending ||
      bindSecretMutation.isPending ||
      (Boolean(runId) && stateQuery.isPending),
    [
      advanceMutation.isPending,
      bindSecretMutation.isPending,
      stateQuery.isPending,
      runId,
      submitInputMutation.isPending,
      submitInterventionMutation.isPending,
    ],
  );

  const activeError = error ?? normalizeError(stateQuery.error);

  return {
    runState: stateQuery.data?.state,
    snapshot: stateQuery.data?.snapshot,
    queue: stateQuery.data?.queue,
    events: stateQuery.data?.events ?? [],
    workflowId: stateQuery.data?.snapshot?.workflow.workflowId,
    isPending,
    error: activeError,
    submitInput,
    submitIntervention,
    advance,
    bindSecret,
    clear,
  };
}

function normalizeError(error: unknown): Error | undefined {
  if (!error) return undefined;
  return error instanceof Error ? error : new Error(String(error));
}

function mergeRunSummary(
  runs: RunSummary[],
  summary: RunSummary,
): RunSummary[] {
  const existingIndex = runs.findIndex((run) => run.runId === summary.runId);
  if (existingIndex === -1) {
    return sortRunsByStartedAtDesc([summary, ...runs]);
  }

  return sortRunsByStartedAtDesc(
    runs.map((run, index) => {
      if (index !== existingIndex) return run;
      return { ...run, ...summary, publishedAt: run.publishedAt };
    }),
  );
}

function sortRunsByStartedAtDesc(runs: RunSummary[]): RunSummary[] {
  return [...runs].sort((a, b) => b.startedAt - a.startedAt);
}

function summarizeRunResult(result: WorkflowRuntimeResult): RunSummary {
  const snapshot = result.snapshot;
  const waitingOn = new Set<string>();
  let terminalNodeCount = 0;
  let failedNodeCount = 0;

  for (const node of snapshot?.nodes ?? []) {
    if (snapshot && isTerminalSummaryNode(snapshot, node))
      terminalNodeCount += 1;
    if (node.status === "errored") failedNodeCount += 1;
    if (node.status === "waiting" && node.waitingOn)
      waitingOn.add(node.waitingOn);
  }

  return {
    runId: result.state.runId,
    status: snapshot?.status ?? "created",
    startedAt: result.state.startedAt,
    publishedAt: Date.now(),
    triggerInputId: result.state.trigger ?? triggerInputFromQueue(result.queue),
    workflowId: snapshot?.workflow.workflowId ?? "",
    version: snapshot?.version ?? 0,
    nodeCount: snapshot?.nodes.length ?? Object.keys(result.state.nodes).length,
    terminalNodeCount,
    waitingOn: [...waitingOn],
    failedNodeCount,
  };
}

function triggerInputFromQueue(
  queue: WorkflowRuntimeResult["queue"],
): string | undefined {
  const first = [
    ...(queue?.pending ?? []),
    ...(queue?.running ?? []),
    ...(queue?.completed ?? []),
    ...(queue?.failed ?? []),
  ]
    .filter((item) => item.event.kind === "input")
    .sort((a, b) => a.enqueuedAt - b.enqueuedAt)[0]?.event;
  return first?.kind === "input" ? first.inputId : undefined;
}

function isTerminalSummaryNode(
  snapshot: RunSnapshot,
  node: RunSnapshot["nodes"][number],
): boolean {
  if (
    node.status === "resolved" ||
    node.status === "skipped" ||
    node.status === "errored"
  ) {
    return true;
  }
  return snapshot.status === "completed" && node.kind === "deferred_input";
}

async function readJsonResponse<TResponse>(
  response: Response,
): Promise<TResponse> {
  if (!response.ok) {
    const message = await errorMessageFromResponse(response);
    throw new Error(message || `Workflow request failed: ${response.status}`);
  }

  return response.json() as Promise<TResponse>;
}

async function errorMessageFromResponse(response: Response): Promise<string> {
  const text = await response.text();
  if (!text) return "";

  try {
    const body = JSON.parse(text) as unknown;
    if (
      body &&
      typeof body === "object" &&
      "message" in body &&
      typeof body.message === "string"
    ) {
      return body.message;
    }
  } catch {
    // Fall through to the raw response body for non-JSON errors.
  }

  return text;
}

function apiUrl(apiBaseUrl: string, path: string): string {
  const suffixIndex = apiBaseUrl.search(/[?#]/);
  if (suffixIndex !== -1) {
    return `${apiBaseUrl.slice(0, suffixIndex).replace(/\/+$/, "")}${path}${apiBaseUrl.slice(suffixIndex)}`;
  }

  return `${apiBaseUrl}${path}`;
}

async function apiGet<TResponse>(
  apiBaseUrl: string,
  path: string,
): Promise<TResponse> {
  return readJsonResponse<TResponse>(await fetch(apiUrl(apiBaseUrl, path)));
}

async function apiPost<TRequest, TResponse>(
  apiBaseUrl: string,
  path: string,
  json: TRequest,
): Promise<TResponse> {
  return readJsonResponse<TResponse>(
    await fetch(apiUrl(apiBaseUrl, path), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(json),
    }),
  );
}

async function apiPut<TRequest, TResponse>(
  apiBaseUrl: string,
  path: string,
  json: TRequest,
): Promise<TResponse> {
  return readJsonResponse<TResponse>(
    await fetch(apiUrl(apiBaseUrl, path), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(json),
    }),
  );
}

function documentResult(document: RunStateDocument): WorkflowRuntimeResult {
  return {
    state: document.state,
    snapshot: document,
    queue: document.queue,
    events: document.events,
  };
}
