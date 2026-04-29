"use client";

import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useWorkflowFrontendConfig } from "../config";
import { DEFAULT_AUTO_ADVANCE } from "../lib/advance-mode";
import { useLocalApiStream } from "../local-api-stream";
import type { RunStateDocument } from "../types";
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
  const config = useWorkflowFrontendConfig();
  const run = useWorkflowRunQuery(runId);
  const [isRunning, setRunning] = useState(DEFAULT_AUTO_ADVANCE);
  const [executingNodeId, setExecutingNodeId] = useState<string | null>(null);

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
    if (!runId) return;
    if (
      !isRunning ||
      !run.runState ||
      runComplete ||
      runIsWaiting ||
      runIsFailed ||
      !hasQueuedWork ||
      run.isPending
    ) {
      return;
    }

    const controller = new AbortController();
    const workflowApiUrl = absolutizeApiBaseUrl(config.apiBaseUrl);

    void fetch(
      `${config.localApiBaseUrl}/api/runs/${encodeURIComponent(runId)}/start-advance`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workflowApiUrl }),
        signal: controller.signal,
      },
    ).catch((err) => {
      if (controller.signal.aborted) return;
      console.error("start-advance failed:", err);
      setRunning(false);
    });

    return () => {
      controller.abort();
      void fetch(
        `${config.localApiBaseUrl}/api/runs/${encodeURIComponent(runId)}/stop-advance`,
        { method: "POST" },
      ).catch(() => {});
    };
  }, [
    runId,
    isRunning,
    run.runState,
    run.isPending,
    hasQueuedWork,
    runComplete,
    runIsWaiting,
    runIsFailed,
    config.apiBaseUrl,
    config.localApiBaseUrl,
  ]);

  useLocalApiStream((message) => {
    if (!runId) return;
    if (message.type === "run_snapshot" && message.runId === runId) {
      run.applyDocument(message.document as RunStateDocument);
      return;
    }
    if (
      (message.type === "run_error" || message.type === "run_stopped") &&
      message.runId === runId
    ) {
      setRunning(false);
    }
  });

  useEffect(() => {
    if (!isRunning) return;
    if (!run.runState) return;
    if (hasQueuedWork || run.isPending) return;
    setRunning(false);
  }, [isRunning, run.runState, run.isPending, hasQueuedWork]);

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

export function useIsRunning(): boolean {
  const ctx = useContext(WorkflowRunContext);
  if (!ctx?.runState) return false;
  return ctx.isRunning;
}

export function useIsSubmittingPendingInput(): boolean {
  const ctx = useContext(WorkflowRunContext);
  return ctx?.isSubmittingPendingInput ?? false;
}

function absolutizeApiBaseUrl(apiBaseUrl: string): string {
  if (typeof window === "undefined") return apiBaseUrl;
  try {
    return new URL(apiBaseUrl, window.location.origin).toString();
  } catch {
    return apiBaseUrl;
  }
}
