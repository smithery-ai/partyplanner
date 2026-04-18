import type { RunState } from "@rxwf/core";
import type { QueueSnapshot, RunEvent, RunSnapshot } from "@rxwf/runtime";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { hc } from "hono/client";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AdvanceWorkflowArgs,
  PollWorkflowStateArgs,
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
  isPending: boolean;
  error: Error | undefined;
  start(args: StartWorkflowArgs): Promise<WorkflowRuntimeResult>;
  submitInput(args: SubmitWorkflowInputArgs): Promise<WorkflowRuntimeResult>;
  advance(args: AdvanceWorkflowArgs): Promise<WorkflowRuntimeResult>;
  setAutoAdvance(
    args: SetAutoAdvanceWorkflowArgs,
  ): Promise<WorkflowRuntimeResult>;
  loadRun(args: PollWorkflowStateArgs): Promise<WorkflowRuntimeResult>;
  refreshRuns(): Promise<void>;
  clear(): void;
};

const backendUrl = import.meta.env.VITE_BACKEND_URL ?? "";
const client = hc<AppType>(backendUrl);

const queryKeys = {
  runs: ["runs"] as const,
  runState: (runId: string) => ["run-state", runId] as const,
};

function useRunsQuery() {
  return useQuery({
    queryKey: queryKeys.runs,
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

function useLoadRunMutation() {
  return useMutation({
    mutationFn: async (args: PollWorkflowStateArgs) => {
      const response = await client.state[":runId"].$get({
        param: { runId: args.runId },
      });
      return documentResult(await readJsonResponse<RunStateDocument>(response));
    },
  });
}

export function useWorkflow(): WorkflowState {
  const queryClient = useQueryClient();
  const runsQuery = useRunsQuery();
  const startMutation = useStartRunMutation();
  const submitInputMutation = useSubmitInputMutation();
  const advanceMutation = useAdvanceRunMutation();
  const setAutoAdvanceMutation = useSetAutoAdvanceMutation();
  const loadRunMutation = useLoadRunMutation();

  const [runState, setRunState] = useState<RunState | undefined>();
  const [snapshot, setSnapshot] = useState<RunSnapshot | undefined>();
  const [queue, setQueue] = useState<QueueSnapshot | undefined>();
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [error, setError] = useState<Error | undefined>();

  const stateQuery = useRunStateQuery(runState?.runId);

  const applyResult = useCallback((result: WorkflowRuntimeResult) => {
    setRunState(result.state);
    setSnapshot(result.snapshot);
    setQueue(result.queue);
    setEvents(result.events ?? []);
  }, []);

  const refreshRuns = useCallback(async () => {
    try {
      await runsQuery.refetch();
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
        applyResult(result);
        await queryClient.invalidateQueries({ queryKey: queryKeys.runs });
        return result;
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        setError(err);
        throw err;
      }
    },
    [applyResult, queryClient],
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

  const loadRun = useCallback(
    (args: PollWorkflowStateArgs) => runMutation(loadRunMutation, args),
    [loadRunMutation, runMutation],
  );

  const clear = useCallback(() => {
    setRunState(undefined);
    setSnapshot(undefined);
    setQueue(undefined);
    setEvents([]);
    setError(undefined);
  }, []);

  useEffect(() => {
    if (!stateQuery.data) return;
    applyResult(stateQuery.data);
    void queryClient.invalidateQueries({ queryKey: queryKeys.runs });
  }, [applyResult, queryClient, stateQuery.data]);

  useEffect(() => {
    if (runsQuery.error) {
      setError(
        runsQuery.error instanceof Error
          ? runsQuery.error
          : new Error(String(runsQuery.error)),
      );
    }
  }, [runsQuery.error]);

  useEffect(() => {
    if (stateQuery.error) {
      setError(
        stateQuery.error instanceof Error
          ? stateQuery.error
          : new Error(String(stateQuery.error)),
      );
    }
  }, [stateQuery.error]);

  const isPending = useMemo(
    () =>
      startMutation.isPending ||
      submitInputMutation.isPending ||
      advanceMutation.isPending ||
      setAutoAdvanceMutation.isPending ||
      loadRunMutation.isPending,
    [
      advanceMutation.isPending,
      loadRunMutation.isPending,
      setAutoAdvanceMutation.isPending,
      startMutation.isPending,
      submitInputMutation.isPending,
    ],
  );

  return {
    runState,
    snapshot,
    queue,
    events,
    runs: runsQuery.data ?? [],
    isPending,
    error,
    start,
    submitInput,
    advance,
    setAutoAdvance,
    loadRun,
    refreshRuns,
    clear,
  };
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
