import type { Handle } from "./handles";
import type { Registry } from "./registry";

export interface Get {
  /** Read a dependency synchronously. Throws SkipError / WaitError / NotReadyError. */
  <T>(source: Handle<T>): T;

  /** Read optionally. Returns undefined on Skip/Wait, but still throws NotReadyError. */
  maybe<T>(source: Handle<T>): T | undefined;

  /** Explicitly skip the current step. */
  skip(): never;
}

export type NodeStatus =
  | "resolved"
  | "skipped"
  | "waiting"
  | "blocked"
  | "errored"
  | "not_reached";

export type NodeRecord = {
  status: NodeStatus;
  value?: unknown;
  error?: { message: string; stack?: string };
  deps: string[];
  duration_ms: number;
  blockedOn?: string;
  waitingOn?: string;
  attempts: number;
};

export type RunState = {
  runId: string;
  startedAt: number;
  trigger?: string;
  payload?: unknown;
  inputs: Record<string, unknown>;
  nodes: Record<string, NodeRecord>;
  waiters: Record<string, string[]>;
  processedEventIds: Record<string, true>;
};

export type RunTrace = {
  runId: string;
  trigger: string;
  payload: unknown;
  startedAt: number;
  completedAt: number;
  nodes: Record<string, NodeRecord>;
};

export type QueueEvent =
  | { kind: "input"; eventId: string; runId: string; inputId: string; payload: unknown }
  | { kind: "step"; eventId: string; runId: string; stepId: string };

export type DispatchResult = {
  state: RunState;
  emitted: QueueEvent[];
  trace: RunTrace;
};

export type StepResolvedEvent = { id: string; value: unknown; duration_ms: number };
export type StepErroredEvent = { id: string; error: Error };
export type StepSkippedEvent = { id: string };
export type StepWaitingEvent = { id: string; waitingOn: string };
export type StepBlockedEvent = { id: string; blockedOn: string };

export type RuntimeOptions = {
  registry?: Registry;
  onEventEmitted?: (ev: QueueEvent) => void;
  onStepResolved?: (ev: StepResolvedEvent) => void;
  onStepErrored?: (ev: StepErroredEvent) => void;
  onStepSkipped?: (ev: StepSkippedEvent) => void;
  onStepWaiting?: (ev: StepWaitingEvent) => void;
  onStepBlocked?: (ev: StepBlockedEvent) => void;
};

export interface Runtime {
  process(event: QueueEvent, state?: RunState): Promise<DispatchResult>;
}
