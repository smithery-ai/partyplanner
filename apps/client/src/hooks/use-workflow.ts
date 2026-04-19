import type { RunState } from "@rxwf/core";
import type { QueueSnapshot, RunEvent, RunSnapshot } from "@rxwf/runtime";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { hc } from "hono/client";
import { useCallback, useMemo, useState } from "react";
import type {
  AdvanceWorkflowArgs,
  SetAutoAdvanceWorkflowArgs,
  StartWorkflowArgs,
  SubmitWorkflowInputArgs,
  WorkflowRuntimeResult,
} from "@/lib/workflow-runtimes";
import type {
  AppType,
  RunStateDocument,
  RunSummary,
  SetAutoAdvanceRequest,
} from "../../../backend/src/rpc";

type JsonPayload =
  | string
  | number
  | boolean
  | null
  | JsonPayload[]
  | { [key: string]: JsonPayload };

export type WorkflowState = {
  runState: RunState | undefined;
  snapshot: RunSnapshot | undefined;
  queue: QueueSnapshot | undefined;
  events: RunEvent[];
  runs: RunSummary[];
  workflowSource: string | undefined;
  autoAdvance: boolean | undefined;
  isPending: boolean;
  error: Error | undefined;
  start(args: StartWorkflowArgs): Promise<WorkflowRuntimeResult>;
  submitInput(args: SubmitWorkflowInputArgs): Promise<WorkflowRuntimeResult>;
  advance(args: AdvanceWorkflowArgs): Promise<WorkflowRuntimeResult>;
  setAutoAdvance(
    args: SetAutoAdvanceWorkflowArgs,
  ): Promise<WorkflowRuntimeResult>;
  refreshRuns(): Promise<void>;
  clear(): void;
};

const backendUrl = import.meta.env.VITE_BACKEND_URL ?? "/api";
const client = hc<AppType>(backendUrl);

const queryKeys = {
  runs: ["runs"] as const,
  runState: (runId: string) => ["run-state", runId] as const,
};

function useRunsQuery() {
  return useQuery({
    queryKey: queryKeys.runs,
    refetchInterval: 500,
    queryFn: async () =>
      readJsonResponse<RunSummary[]>(await client.runs.$get({})),
  });
}

function useRunStateQuery(runId: string | undefined) {
  return useQuery({
    queryKey: runId ? queryKeys.runState(runId) : ["run-state", "none"],
    enabled: Boolean(runId),
    refetchInterval: 500,
    queryFn: async () => {
      if (!runId) throw new Error("Cannot poll before a run exists.");
      const response = await client.state[":runId"].$get({
        param: { runId },
      });
      return documentResult(await readJsonResponse<RunStateDocument>(response));
    },
  });
}

function useStartRunMutation() {
  return useMutation({
    mutationFn: async (args: StartWorkflowArgs) => {
      const body = {
        workflowSource: args.workflowSource,
        inputId: args.inputId,
        payload: args.payload as JsonPayload,
        autoAdvance: args.autoAdvance,
      };
      const response = await client.runs.$post({ json: body });
      return documentResult(await readJsonResponse<RunStateDocument>(response));
    },
  });
}

function useSubmitInputMutation() {
  return useMutation({
    mutationFn: async (args: SubmitWorkflowInputArgs) => {
      if (!args.state)
        throw new Error("Cannot submit input before a run exists.");

      const body = {
        inputId: args.inputId,
        payload: args.payload as JsonPayload,
        autoAdvance: args.autoAdvance,
      };
      const response = await client.runs[":runId"].inputs.$post({
        param: { runId: args.state.runId },
        json: body,
      });
      return documentResult(await readJsonResponse<RunStateDocument>(response));
    },
  });
}

function useAdvanceRunMutation() {
  return useMutation({
    mutationFn: async (args: AdvanceWorkflowArgs) => {
      if (!args.state) throw new Error("Cannot advance before a run exists.");

      const response = await client.runs[":runId"].advance.$post({
        param: { runId: args.state.runId },
        json: {},
      });
      return documentResult(await readJsonResponse<RunStateDocument>(response));
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
      const response = await client.runs[":runId"]["auto-advance"].$post({
        param: { runId: args.state.runId },
        json: body,
      });
      return documentResult(await readJsonResponse<RunStateDocument>(response));
    },
  });
}

export function useWorkflow(activeRunId?: string): WorkflowState {
  const queryClient = useQueryClient();
  const runsQuery = useRunsQuery();
  const startMutation = useStartRunMutation();
  const submitInputMutation = useSubmitInputMutation();
  const advanceMutation = useAdvanceRunMutation();
  const setAutoAdvanceMutation = useSetAutoAdvanceMutation();

  const [error, setError] = useState<Error | undefined>();

  const stateQuery = useRunStateQuery(activeRunId);

  const cacheResult = useCallback(
    (result: WorkflowRuntimeResult) => {
      queryClient.setQueryData(queryKeys.runState(result.state.runId), result);
    },
    [queryClient],
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

  const start = useCallback(
    (args: StartWorkflowArgs) => runMutation(startMutation, args),
    [runMutation, startMutation],
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
      startMutation.isPending ||
      submitInputMutation.isPending ||
      advanceMutation.isPending ||
      setAutoAdvanceMutation.isPending ||
      (Boolean(activeRunId) && stateQuery.isPending),
    [
      advanceMutation.isPending,
      setAutoAdvanceMutation.isPending,
      stateQuery.isPending,
      activeRunId,
      startMutation.isPending,
      submitInputMutation.isPending,
    ],
  );

  const queryError = runsQuery.error ?? stateQuery.error;
  const activeError = error ?? normalizeError(queryError);

  return {
    runState: stateQuery.data?.state,
    snapshot: stateQuery.data?.snapshot,
    queue: stateQuery.data?.queue,
    events: stateQuery.data?.events ?? [],
    runs: runsQuery.data ?? [],
    workflowSource: stateQuery.data?.workflowSource,
    autoAdvance: stateQuery.data?.autoAdvance,
    isPending,
    error: activeError,
    start,
    submitInput,
    advance,
    setAutoAdvance,
    refreshRuns,
    clear,
  };
}

function normalizeError(error: unknown): Error | undefined {
  if (!error) return undefined;
  return error instanceof Error ? error : new Error(String(error));
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
