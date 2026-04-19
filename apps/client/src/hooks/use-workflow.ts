import type { RunState } from "@rxwf/core";
import type { QueueSnapshot, RunEvent, RunSnapshot } from "@rxwf/runtime";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import type {
  AdvanceWorkflowArgs,
  SetAutoAdvanceWorkflowArgs,
  SubmitWorkflowInputArgs,
  WorkflowRuntimeResult,
} from "@/lib/workflow-runtimes";
import type {
  CreateWorkflowRequest,
  RunStateDocument,
  RunSummary,
  SetAutoAdvanceRequest,
  StartWorkflowRunRequest,
  SubmitBackendInputRequest,
  WorkflowManifest,
} from "../../../backend/src/rpc";

type JsonPayload =
  | string
  | number
  | boolean
  | null
  | JsonPayload[]
  | { [key: string]: JsonPayload };

export type StartRunArgs = {
  inputId: string;
  payload: unknown;
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

const backendUrl = import.meta.env.VITE_BACKEND_URL ?? "/api";

const queryKeys = {
  workflows: ["workflows"] as const,
  workflow: (workflowId: string) => ["workflow", workflowId] as const,
  runs: ["runs"] as const,
  runState: (runId: string) => ["run-state", runId] as const,
};

function useWorkflowsQuery() {
  return useQuery({
    queryKey: queryKeys.workflows,
    queryFn: async () => apiGet<WorkflowManifest[]>("/workflows"),
  });
}

function useWorkflowManifestQuery(workflowId: string | undefined) {
  return useQuery({
    queryKey: workflowId
      ? queryKeys.workflow(workflowId)
      : ["workflow", "none"],
    enabled: Boolean(workflowId),
    retry: false,
    queryFn: async () => {
      if (!workflowId) throw new Error("workflowId required.");
      return apiGet<WorkflowManifest>(
        `/workflows/${encodeURIComponent(workflowId)}`,
      );
    },
  });
}

function useRunsQuery() {
  return useQuery({
    queryKey: queryKeys.runs,
    refetchInterval: 500,
    queryFn: async () => apiGet<RunSummary[]>("/runs"),
  });
}

function useRunStateQuery(runId: string | undefined) {
  return useQuery({
    queryKey: runId ? queryKeys.runState(runId) : ["run-state", "none"],
    enabled: Boolean(runId),
    refetchInterval: 500,
    queryFn: async () => {
      if (!runId) throw new Error("Cannot poll before a run exists.");
      return documentResult(
        await apiGet<RunStateDocument>(`/state/${encodeURIComponent(runId)}`),
      );
    },
  });
}

function useStartWorkflowRunMutation(workflowId: string | undefined) {
  return useMutation({
    mutationFn: async (args: StartRunArgs) => {
      if (!workflowId) throw new Error("workflowId required to start a run.");
      const body: StartWorkflowRunRequest = {
        inputId: args.inputId,
        payload: args.payload as JsonPayload,
        autoAdvance: args.autoAdvance,
      };
      return documentResult(
        await apiPost<StartWorkflowRunRequest, RunStateDocument>(
          `/workflows/${encodeURIComponent(workflowId)}/runs`,
          body,
        ),
      );
    },
  });
}

function useSubmitInputMutation() {
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
          `/runs/${encodeURIComponent(args.state.runId)}/inputs`,
          body,
        ),
      );
    },
  });
}

function useAdvanceRunMutation() {
  return useMutation({
    mutationFn: async (args: AdvanceWorkflowArgs) => {
      if (!args.state) throw new Error("Cannot advance before a run exists.");

      return documentResult(
        await apiPost<Record<string, never>, RunStateDocument>(
          `/runs/${encodeURIComponent(args.state.runId)}/advance`,
          {},
        ),
      );
    },
  });
}

function useSetAutoAdvanceMutation() {
  return useMutation({
    mutationFn: async (args: SetAutoAdvanceWorkflowArgs) => {
      if (!args.state)
        throw new Error("Cannot change advance mode before a run exists.");

      const body: SetAutoAdvanceRequest = {
        autoAdvance: args.autoAdvance,
      };
      return documentResult(
        await apiPost<SetAutoAdvanceRequest, RunStateDocument>(
          `/runs/${encodeURIComponent(args.state.runId)}/auto-advance`,
          body,
        ),
      );
    },
  });
}

function useCreateWorkflowMutation() {
  return useMutation({
    mutationFn: async (args: CreateWorkflowArgs) => {
      return apiPost<CreateWorkflowRequest, WorkflowManifest>("/workflows", {
        workflowSource: args.workflowSource,
        workflowId: args.workflowId,
        name: args.name,
      });
    },
  });
}

export function useWorkflows(): WorkflowsState {
  const queryClient = useQueryClient();
  const workflowsQuery = useWorkflowsQuery();
  const createMutation = useCreateWorkflowMutation();
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
          queryKeys.workflow(manifest.workflowId),
          manifest,
        );
        await queryClient.invalidateQueries({ queryKey: queryKeys.workflows });
        return manifest;
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        setError(err);
        throw err;
      }
    },
    [createMutation, queryClient],
  );

  return {
    workflows: workflowsQuery.data ?? [],
    isPending: workflowsQuery.isPending || createMutation.isPending,
    error: error ?? normalizeError(workflowsQuery.error),
    refresh,
    createWorkflow,
  };
}

export function useWorkflow(workflowId: string | undefined): WorkflowState {
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
          queryKeys.runState(result.state.runId),
          result,
        );
        queryClient.setQueryData(
          queryKeys.runs,
          (existing: RunSummary[] = []) =>
            mergeRunSummary(existing, summarizeRunResult(result)),
        );
        await queryClient.invalidateQueries({ queryKey: queryKeys.runs });
        return result;
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        setError(err);
        throw err;
      }
    },
    [queryClient, startMutation],
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
    (Boolean(workflowId) && manifestQuery.isPending) || startMutation.isPending;

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
  const queryClient = useQueryClient();
  const stateQuery = useRunStateQuery(runId);
  const submitInputMutation = useSubmitInputMutation();
  const advanceMutation = useAdvanceRunMutation();
  const setAutoAdvanceMutation = useSetAutoAdvanceMutation();
  const [error, setError] = useState<Error | undefined>();

  const cacheResult = useCallback(
    (result: WorkflowRuntimeResult) => {
      queryClient.setQueryData(queryKeys.runState(result.state.runId), result);
      queryClient.setQueryData(queryKeys.runs, (existing: RunSummary[] = []) =>
        mergeRunSummary(existing, summarizeRunResult(result)),
      );
    },
    [queryClient],
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
        await queryClient.invalidateQueries({ queryKey: queryKeys.runs });
        return result;
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        setError(err);
        throw err;
      }
    },
    [cacheResult, queryClient],
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
    const message = await response.text();
    throw new Error(message || `Workflow request failed: ${response.status}`);
  }

  return response.json() as Promise<TResponse>;
}

function apiUrl(path: string): string {
  return `${backendUrl.replace(/\/$/, "")}${path}`;
}

async function apiGet<TResponse>(path: string): Promise<TResponse> {
  return readJsonResponse<TResponse>(await fetch(apiUrl(path)));
}

async function apiPost<TRequest, TResponse>(
  path: string,
  json: TRequest,
): Promise<TResponse> {
  return readJsonResponse<TResponse>(
    await fetch(apiUrl(path), {
      method: "POST",
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
    workflowSource: document.workflowSource,
    autoAdvance: document.autoAdvance,
  };
}
