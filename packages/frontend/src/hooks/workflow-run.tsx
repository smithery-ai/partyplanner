"use client";

import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { DEFAULT_AUTO_ADVANCE } from "../lib/advance-mode";
import { useWorkflowRunQuery, type WorkflowRunState } from "./use-workflow";

export type WorkflowRunContextValue = WorkflowRunState & {
  isRunning: boolean;
  setRunning: (running: boolean) => void;
  executingNodeId: string | null;
  runComplete: boolean;
};

const WorkflowRunContext = createContext<WorkflowRunContextValue | null>(null);

export function WorkflowRunProvider({
  runId,
  children,
}: {
  runId: string | undefined;
  children: ReactNode;
}) {
  const run = useWorkflowRunQuery(runId);
  const [isRunning, setRunning] = useState(DEFAULT_AUTO_ADVANCE);
  const [executingNodeId, setExecutingNodeId] = useState<string | null>(null);
  const autoAdvanceInFlight = useRef(false);

  const runStatus = run.snapshot?.status;
  const runComplete = runStatus === "completed";
  const runIsWaiting = runStatus === "waiting";
  const runIsFailed = runStatus === "failed";
  const hasQueuedWork = (run.queue?.pending.length ?? 0) > 0;

  useEffect(() => {
    if (!run.isPending) {
      setExecutingNodeId(null);
      return;
    }
    const head = run.queue?.pending[0]?.event;
    if (!head) return;
    const id = head.kind === "input" ? head.inputId : head.stepId;
    setExecutingNodeId((prev) => prev ?? id);
  }, [run.isPending, run.queue]);

  useEffect(() => {
    if (
      !isRunning ||
      !run.runState ||
      runComplete ||
      runIsWaiting ||
      runIsFailed ||
      !hasQueuedWork ||
      run.isPending ||
      autoAdvanceInFlight.current
    ) {
      return;
    }

    let active = true;
    autoAdvanceInFlight.current = true;

    void run
      .advance({ state: run.runState })
      .catch(() => {
        if (!active) return;
        setRunning(false);
      })
      .finally(() => {
        autoAdvanceInFlight.current = false;
      });

    return () => {
      active = false;
    };
  }, [
    isRunning,
    run.runState,
    run.isPending,
    run.advance,
    hasQueuedWork,
    runComplete,
    runIsWaiting,
    runIsFailed,
  ]);

  useEffect(() => {
    if (!isRunning) return;
    if (!run.runState) return;
    // Don't clear while any mutation is in flight — the snapshot we're reading
    // was computed BEFORE the mutation and may still report `waiting` even
    // though the user has just submitted the input that will unstick the run.
    if (hasQueuedWork || run.isPending || autoAdvanceInFlight.current) return;
    if (runComplete || runIsWaiting || runIsFailed) {
      setRunning(false);
      return;
    }
    // Queue drained, nothing in flight, run not terminal — nothing to do.
    setRunning(false);
  }, [
    isRunning,
    run.runState,
    run.isPending,
    hasQueuedWork,
    runComplete,
    runIsWaiting,
    runIsFailed,
  ]);

  const value: WorkflowRunContextValue = {
    ...run,
    isRunning,
    setRunning,
    executingNodeId,
    runComplete,
  };

  return (
    <WorkflowRunContext.Provider value={value}>
      {children}
    </WorkflowRunContext.Provider>
  );
}

export function useWorkflowRun(): WorkflowRunContextValue {
  const ctx = useContext(WorkflowRunContext);
  if (!ctx) {
    throw new Error(
      "useWorkflowRun must be used within a <WorkflowRunProvider>",
    );
  }
  return ctx;
}

/**
 * Lenient accessor for form primitives (e.g. `JsonSchemaForm`) that may be
 * rendered outside a run context. Returns `false` when no provider is mounted.
 */
export function useIsRunning(): boolean {
  const ctx = useContext(WorkflowRunContext);
  return ctx?.isRunning ?? false;
}
