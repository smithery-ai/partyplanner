import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RunState } from "@workflow/core";
import type { QueueSnapshot, RunEvent, RunSnapshot } from "@workflow/runtime";
import { useCallback, useMemo, useState } from "react";
import { useWorkflowFrontendConfig } from "../config";
import type {
  AdvanceWorkflowArgs,
  SetAutoAdvanceWorkflowArgs,
  SubmitWorkflowInputArgs,
} from "../lib/workflow-runtimes";
import type {
  CreateWorkflowRequest,
  DeleteWorkflowResponse,
  JsonPayload,
  RunStateDocument,
  RunSummary,
  SetAutoAdvanceRequest,
  StartBackendRunRequest,
  StartWorkflowRunRequest,
  SubmitBackendInputRequest,
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
  autoAdvance?: boolean;
};

export type CreateWorkflowArgs = {
  workflowSource: string;
  workflowId?: string;
  name?: string;
};

export type WorkflowsState = {
  workflows: WorkflowManifest[];
  isPending: boolean;
  error: Error | undefined;
  refresh(): Promise<void>;
  createWorkflow(args: CreateWorkflowArgs): Promise<WorkflowManifest>;
  deleteWorkflow(workflowId: string): Promise<void>;
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
  workflowSource: string | undefined;
  workflowId: string | undefined;
  autoAdvance: boolean | undefined;
  isPending: boolean;
  error: Error | undefined;
  submitInput(args: SubmitWorkflowInputArgs): Promise<WorkflowRuntimeResult>;
  advance(args: AdvanceWorkflowArgs): Promise<WorkflowRuntimeResult>;
  setAutoAdvance(
    args: SetAutoAdvanceWorkflowArgs,
  ): Promise<WorkflowRuntimeResult>;
  clear(): void;
};

const queryKeys = {
  workflows: (apiMode: string, apiBaseUrl: string) =>
    ["workflow-frontend", apiMode, apiBaseUrl, "workflows"] as const,
  workflow: (apiMode: string, apiBaseUrl: string, workflowId: string) =>
    ["workflow-frontend", apiMode, apiBaseUrl, "workflow", workflowId] as const,
  runs: (apiMode: string, apiBaseUrl: string) =>
    ["workflow-frontend", apiMode, apiBaseUrl, "runs"] as const,
  runState: (apiMode: string, apiBaseUrl: string, runId: string) =>
    ["workflow-frontend", apiMode, apiBaseUrl, "run-state", runId] as const,
};

function useWorkflowsQuery() {
  const config = useWorkflowFrontendConfig();
  return useQuery({
    queryKey: queryKeys.workflows(config.apiMode, config.apiBaseUrl),
    queryFn: async () => {
      if (config.apiMode === "single") {
        return [await apiGet<WorkflowManifest>(config.apiBaseUrl, "/manifest")];
      }
      return apiGet<WorkflowManifest[]>(config.apiBaseUrl, "/workflows");
    },
  });
}

function useWorkflowManifestQuery(workflowId: string | undefined) {
  const config = useWorkflowFrontendConfig();
  return useQuery({
    queryKey: workflowId
      ? queryKeys.workflow(config.apiMode, config.apiBaseUrl, workflowId)
      : [
          "workflow-frontend",
          config.apiMode,
          config.apiBaseUrl,
          "workflow",
          "none",
        ],
    enabled: config.apiMode === "single" || Boolean(workflowId),
    retry: false,
    queryFn: async () => {
      if (config.apiMode === "single") {
        return apiGet<WorkflowManifest>(config.apiBaseUrl, "/manifest");
      }
      if (!workflowId) throw new Error("workflowId required.");
      return apiGet<WorkflowManifest>(
        config.apiBaseUrl,
        `/workflows/${encodeURIComponent(workflowId)}`,
      );
    },
  });
}

function useRunsQuery() {
  const config = useWorkflowFrontendConfig();
  return useQuery({
    queryKey: queryKeys.runs(config.apiMode, config.apiBaseUrl),
    refetchInterval: 500,
    queryFn: async () => apiGet<RunSummary[]>(config.apiBaseUrl, "/runs"),
  });
}

function useRunStateQuery(runId: string | undefined) {
  const config = useWorkflowFrontendConfig();
  return useQuery({
    queryKey: runId
      ? queryKeys.runState(config.apiMode, config.apiBaseUrl, runId)
      : [
          "workflow-frontend",
          config.apiMode,
          config.apiBaseUrl,
          "run-state",
          "none",
        ],
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

function useStartWorkflowRunMutation(workflowId: string | undefined) {
  const config = useWorkflowFrontendConfig();
  return useMutation({
    mutationFn: async (args: StartRunArgs) => {
      const body: StartWorkflowRunRequest = {
        inputId: args.inputId,
        payload: args.payload as JsonPayload,
        additionalInputs: args.additionalInputs as
          | { inputId: string; payload: JsonPayload }[]
          | undefined,
        autoAdvance: args.autoAdvance,
      };
      if (config.apiMode === "single") {
        return documentResult(
          await apiPost<StartWorkflowRunRequest, RunStateDocument>(
            config.apiBaseUrl,
            "/runs",
            body,
          ),
        );
      }

      if (!workflowId) throw new Error("workflowId required to start a run.");
      return documentResult(
        await apiPost<StartBackendRunRequest, RunStateDocument>(
          config.apiBaseUrl,
          `/workflows/${encodeURIComponent(workflowId)}/runs`,
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
        autoAdvance: args.autoAdvance,
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

function useAdvanceRunMutation() {
  const config = useWorkflowFrontendConfig();
  return useMutation({
    mutationFn: async (args: AdvanceWorkflowArgs) => {
      if (!args.state) throw new Error("Cannot advance before a run exists.");

      return documentResult(
        await apiPost<Record<string, never>, RunStateDocument>(
          config.apiBaseUrl,
          `/runs/${encodeURIComponent(args.state.runId)}/advance`,
          {},
        ),
      );
    },
  });
}

function useSetAutoAdvanceMutation() {
  const config = useWorkflowFrontendConfig();
  return useMutation({
    mutationFn: async (args: SetAutoAdvanceWorkflowArgs) => {
      if (!args.state)
        throw new Error("Cannot change advance mode before a run exists.");

      const body: SetAutoAdvanceRequest = {
        autoAdvance: args.autoAdvance,
      };
      return documentResult(
        await apiPost<SetAutoAdvanceRequest, RunStateDocument>(
          config.apiBaseUrl,
          `/runs/${encodeURIComponent(args.state.runId)}/auto-advance`,
          body,
        ),
      );
    },
  });
}

function useCreateWorkflowMutation() {
  const config = useWorkflowFrontendConfig();
  return useMutation({
    mutationFn: async (args: CreateWorkflowArgs) => {
      if (config.apiMode === "single") {
        throw new Error("This workflow server does not support uploads.");
      }
      return apiPost<CreateWorkflowRequest, WorkflowManifest>(
        config.apiBaseUrl,
        "/workflows",
        {
          workflowSource: args.workflowSource,
          workflowId: args.workflowId,
          name: args.name,
        },
      );
    },
  });
}

function useDeleteWorkflowMutation() {
  const config = useWorkflowFrontendConfig();
  return useMutation({
    mutationFn: async (workflowId: string) => {
      if (config.apiMode === "single") {
        throw new Error("This workflow server does not support deletion.");
      }
      await apiDelete<DeleteWorkflowResponse>(
        config.apiBaseUrl,
        `/workflows/${encodeURIComponent(workflowId)}`,
      );
    },
  });
}

export function useWorkflows(): WorkflowsState {
  const config = useWorkflowFrontendConfig();
  const queryClient = useQueryClient();
  const workflowsQuery = useWorkflowsQuery();
  const createMutation = useCreateWorkflowMutation();
  const deleteMutation = useDeleteWorkflowMutation();
  const [error, setError] = useState<Error | undefined>();

  const refresh = useCallback(async () => {
    try {
      const result = await workflowsQuery.refetch();
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
  }, [workflowsQuery]);

  const createWorkflow = useCallback(
    async (args: CreateWorkflowArgs) => {
      setError(undefined);
      try {
        const manifest = await createMutation.mutateAsync(args);
        queryClient.setQueryData(
          queryKeys.workflow(
            config.apiMode,
            config.apiBaseUrl,
            manifest.workflowId,
          ),
          manifest,
        );
        await queryClient.invalidateQueries({
          queryKey: queryKeys.workflows(config.apiMode, config.apiBaseUrl),
        });
        return manifest;
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        setError(err);
        throw err;
      }
    },
    [config.apiBaseUrl, config.apiMode, createMutation, queryClient],
  );

  const deleteWorkflow = useCallback(
    async (workflowId: string) => {
      setError(undefined);
      try {
        await deleteMutation.mutateAsync(workflowId);
        queryClient.removeQueries({
          queryKey: queryKeys.workflow(
            config.apiMode,
            config.apiBaseUrl,
            workflowId,
          ),
        });
        await queryClient.invalidateQueries({
          queryKey: queryKeys.workflows(config.apiMode, config.apiBaseUrl),
        });
        await queryClient.invalidateQueries({
          queryKey: queryKeys.runs(config.apiMode, config.apiBaseUrl),
        });
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        setError(err);
        throw err;
      }
    },
    [config.apiBaseUrl, config.apiMode, deleteMutation, queryClient],
  );

  return {
    workflows: workflowsQuery.data ?? [],
    isPending:
      workflowsQuery.isPending ||
      createMutation.isPending ||
      deleteMutation.isPending,
    error: error ?? normalizeError(workflowsQuery.error),
    refresh,
    createWorkflow,
    deleteWorkflow,
  };
}

export function useWorkflow(workflowId: string | undefined): WorkflowState {
  const config = useWorkflowFrontendConfig();
  const queryClient = useQueryClient();
  const manifestQuery = useWorkflowManifestQuery(workflowId);
  const runsQuery = useRunsQuery();
  const startMutation = useStartWorkflowRunMutation(workflowId);
  const [error, setError] = useState<Error | undefined>();

  const runs = useMemo(() => {
    if (!workflowId) return [];
    return (runsQuery.data ?? []).filter(
      (run) => run.workflowId === workflowId,
    );
  }, [runsQuery.data, workflowId]);

  const start = useCallback(
    async (args: StartRunArgs) => {
      setError(undefined);
      try {
        const result = await startMutation.mutateAsync(args);
        queryClient.setQueryData(
          queryKeys.runState(
            config.apiMode,
            config.apiBaseUrl,
            result.state.runId,
          ),
          result,
        );
        queryClient.setQueryData(
          queryKeys.runs(config.apiMode, config.apiBaseUrl),
          (existing: RunSummary[] = []) =>
            mergeRunSummary(existing, summarizeRunResult(result)),
        );
        await queryClient.invalidateQueries({
          queryKey: queryKeys.runs(config.apiMode, config.apiBaseUrl),
        });
        return result;
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        setError(err);
        throw err;
      }
    },
    [config.apiBaseUrl, config.apiMode, queryClient, startMutation],
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

  const isPending =
    ((config.apiMode === "single" || Boolean(workflowId)) &&
      manifestQuery.isPending) ||
    startMutation.isPending;

  const activeError =
    error ?? normalizeError(manifestQuery.error ?? runsQuery.error);

  const manifestNotFound =
    Boolean(workflowId) &&
    !manifestQuery.isPending &&
    !manifestQuery.data &&
    Boolean(manifestQuery.error);

  return {
    manifest: manifestQuery.data,
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
  const advanceMutation = useAdvanceRunMutation();
  const setAutoAdvanceMutation = useSetAutoAdvanceMutation();
  const [error, setError] = useState<Error | undefined>();

  const cacheResult = useCallback(
    (result: WorkflowRuntimeResult) => {
      queryClient.setQueryData(
        queryKeys.runState(
          config.apiMode,
          config.apiBaseUrl,
          result.state.runId,
        ),
        result,
      );
      queryClient.setQueryData(
        queryKeys.runs(config.apiMode, config.apiBaseUrl),
        (existing: RunSummary[] = []) =>
          mergeRunSummary(existing, summarizeRunResult(result)),
      );
    },
    [config.apiBaseUrl, config.apiMode, queryClient],
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
          queryKey: queryKeys.runs(config.apiMode, config.apiBaseUrl),
        });
        return result;
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        setError(err);
        throw err;
      }
    },
    [cacheResult, config.apiBaseUrl, config.apiMode, queryClient],
  );

  const submitInput = useCallback(
    (args: SubmitWorkflowInputArgs) => runMutation(submitInputMutation, args),
    [runMutation, submitInputMutation],
  );

  const advance = useCallback(
    (args: AdvanceWorkflowArgs) => runMutation(advanceMutation, args),
    [advanceMutation, runMutation],
  );

  const setAutoAdvance = useCallback(
    (args: SetAutoAdvanceWorkflowArgs) =>
      runMutation(setAutoAdvanceMutation, args),
    [runMutation, setAutoAdvanceMutation],
  );

  const clear = useCallback(() => {
    setError(undefined);
  }, []);

  const isPending = useMemo(
    () =>
      submitInputMutation.isPending ||
      advanceMutation.isPending ||
      setAutoAdvanceMutation.isPending ||
      (Boolean(runId) && stateQuery.isPending),
    [
      advanceMutation.isPending,
      setAutoAdvanceMutation.isPending,
      stateQuery.isPending,
      runId,
      submitInputMutation.isPending,
    ],
  );

  const activeError = error ?? normalizeError(stateQuery.error);

  return {
    runState: stateQuery.data?.state,
    snapshot: stateQuery.data?.snapshot,
    queue: stateQuery.data?.queue,
    events: stateQuery.data?.events ?? [],
    workflowSource: stateQuery.data?.workflowSource,
    workflowId: stateQuery.data?.snapshot?.workflow.workflowId,
    autoAdvance: stateQuery.data?.autoAdvance,
    isPending,
    error: activeError,
    submitInput,
    advance,
    setAutoAdvance,
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
    workflowId: snapshot?.workflow.workflowId ?? "",
    version: snapshot?.version ?? 0,
    nodeCount: snapshot?.nodes.length ?? Object.keys(result.state.nodes).length,
    terminalNodeCount,
    waitingOn: [...waitingOn],
    failedNodeCount,
  };
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

async function apiDelete<TResponse>(
  apiBaseUrl: string,
  path: string,
): Promise<TResponse> {
  return readJsonResponse<TResponse>(
    await fetch(apiUrl(apiBaseUrl, path), {
      method: "DELETE",
    }),
  );
}

function documentResult(document: RunStateDocument): WorkflowRuntimeResult {
  return {
    state: document.state,
    snapshot: document,
    queue: document.queue,
    events: document.events,
    workflowSource: document.workflowSource,
    autoAdvance: document.autoAdvance,
  };
}
