import type { RunState } from "@rxwf/core";
import type { QueueSnapshot, RunEvent, RunSnapshot } from "@rxwf/runtime";
import { useCallback, useEffect, useRef, useState } from "react";

import type {
  AdvanceWorkflowArgs,
  StartWorkflowArgs,
  SubmitWorkflowInputArgs,
  WorkflowRuntime,
} from "@/lib/workflow-runtimes";

export type WorkflowState = {
  runState: RunState | undefined;
  snapshot: RunSnapshot | undefined;
  queue: QueueSnapshot | undefined;
  events: RunEvent[];
  isPending: boolean;
  error: Error | undefined;
  start(args: StartWorkflowArgs): Promise<void>;
  submitInput(args: SubmitWorkflowInputArgs): Promise<void>;
  advance(args: AdvanceWorkflowArgs): Promise<void>;
  clear(): void;
};

export function useWorkflow(runtime: WorkflowRuntime): WorkflowState {
  const runtimeRef = useRef(runtime);
  const [runState, setRunState] = useState<RunState | undefined>();
  const [snapshot, setSnapshot] = useState<RunSnapshot | undefined>();
  const [queue, setQueue] = useState<QueueSnapshot | undefined>();
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<Error | undefined>();
  const pollingRef = useRef(false);

  const applyResult = useCallback(
    (result: Awaited<ReturnType<WorkflowRuntime["start"]>>) => {
      setRunState(result.state);
      setSnapshot(result.snapshot);
      setQueue(result.queue);
      setEvents(result.events ?? []);
    },
    [],
  );

  const run = useCallback(
    async <TArgs>(
      action: (
        runtime: WorkflowRuntime,
        args: TArgs,
      ) => Promise<Awaited<ReturnType<WorkflowRuntime["start"]>>>,
      args: TArgs,
    ) => {
      setIsPending(true);
      setError(undefined);
      try {
        applyResult(await action(runtimeRef.current, args));
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        setError(err);
        throw err;
      } finally {
        setIsPending(false);
      }
    },
    [applyResult],
  );

  const start = useCallback(
    (args: StartWorkflowArgs) =>
      run((runtime, next) => runtime.start(next), args),
    [run],
  );

  const submitInput = useCallback(
    (args: SubmitWorkflowInputArgs) =>
      run((runtime, next) => runtime.submitInput(next), args),
    [run],
  );

  const advance = useCallback(
    (args: AdvanceWorkflowArgs) =>
      run((runtime, next) => runtime.advance(next), args),
    [run],
  );

  const clear = useCallback(() => {
    runtimeRef.current.reset?.();
    setRunState(undefined);
    setSnapshot(undefined);
    setQueue(undefined);
    setEvents([]);
    setError(undefined);
    setIsPending(false);
  }, []);

  useEffect(() => {
    const runtime = runtimeRef.current;
    const getState = runtime.getState;
    const runId = runState?.runId;
    if (!getState || !runId) return;

    let cancelled = false;
    const poll = async () => {
      if (pollingRef.current) return;
      pollingRef.current = true;
      try {
        const result = await getState.call(runtime, { runId });
        if (!cancelled) applyResult(result);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e : new Error(String(e)));
      } finally {
        pollingRef.current = false;
      }
    };

    const interval = window.setInterval(() => void poll(), 500);
    void poll();

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [applyResult, runState?.runId]);

  return {
    runState,
    snapshot,
    queue,
    events,
    isPending,
    error,
    start,
    submitInput,
    advance,
    clear,
  };
}
