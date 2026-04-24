import type { ZodSchema } from "zod";
import type { Handle } from "./handles";
import type { Registry } from "./registry";

export type JsonSchema = Record<string, unknown>;

export type InterventionAction =
  | {
      type: "open_url";
      url: string;
      label?: string;
    }
  | {
      type: "message";
      label?: string;
    };

export type InterventionRequest = {
  id: string;
  stepId: string;
  key: string;
  status: "pending" | "resolved";
  schema: JsonSchema;
  title?: string;
  description?: string;
  action?: InterventionAction;
  /**
   * URL the human should open to perform the out-of-band action (e.g. an OAuth
   * consent screen). When set, the UI surfaces this link prominently and
   * collapses the manual payload form behind a toggle.
   */
  actionUrl?: string;
  createdAt: number;
  resolvedAt?: number;
};

export type InterventionOptions = {
  title?: string;
  description?: string;
  action?: InterventionAction;
  /** See {@link InterventionRequest.actionUrl}. */
  actionUrl?: string;
};

export type RequestIntervention = <T>(
  key: string,
  schema: ZodSchema<T>,
  opts?: InterventionOptions,
) => T;

export type AtomRuntimeContext = {
  runId: string;
  stepId: string;
  invocationReason?: "dependency" | "managed_connection";
  interventionId: (key: string) => string;
};

export interface Get {
  /** Read a dependency synchronously. Throws SkipError / WaitError / NotReadyError. */
  <T>(source: Handle<T>): T;

  /** Read optionally. Returns undefined on Skip/Wait, but still throws NotReadyError. */
  maybe<T>(source: Handle<T>): T | undefined;

  /** Explicitly skip the current step. */
  skip(reason?: string): never;
}

export type NodeStatus =
  | "resolved"
  | "skipped"
  | "waiting"
  | "blocked"
  | "errored"
  | "not_reached";

export type NodeKind =
  | "input"
  | "deferred_input"
  | "atom"
  | "action"
  | "webhook";

export type NodeRecord = {
  status: NodeStatus;
  kind?: NodeKind;
  value?: unknown;
  error?: { message: string; stack?: string };
  deps: string[];
  duration_ms: number;
  blockedOn?: string;
  waitingOn?: string;
  skipReason?: string;
  attempts: number;
};

export type RunState = {
  runId: string;
  startedAt: number;
  trigger?: string;
  payload?: unknown;
  webhook?: {
    nodeId: string;
    matchedInputs: string[];
    receivedAt: number;
  };
  terminal?: {
    status: "failed" | "canceled";
    reason?: string;
  };
  inputs: Record<string, unknown>;
  interventions: Record<string, InterventionRequest>;
  nodes: Record<string, NodeRecord>;
  waiters: Record<string, string[]>;
  processedEventIds: Record<string, true>;
};

export type RunTrace = {
  runId: string;
  trigger?: string;
  payload?: unknown;
  startedAt: number;
  completedAt: number;
  nodes: Record<string, NodeRecord>;
};

export type QueueEvent =
  | {
      kind: "input";
      eventId: string;
      runId: string;
      inputId: string;
      payload: unknown;
    }
  | {
      kind: "step";
      eventId: string;
      runId: string;
      stepId: string;
      reason?: "dependency" | "managed_connection";
    };

export type DispatchResult = {
  state: RunState;
  emitted: QueueEvent[];
  trace: RunTrace;
};

export type StepResolvedEvent = {
  id: string;
  value: unknown;
  duration_ms: number;
};
export type StepErroredEvent = { id: string; error: Error };
export type StepSkippedEvent = { id: string; reason?: string };
export type StepWaitingEvent = { id: string; waitingOn: string };
export type StepBlockedEvent = { id: string; blockedOn: string };

export type RuntimeOptions = {
  registry?: Registry;
  secretValues?: Record<string, string>;
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
