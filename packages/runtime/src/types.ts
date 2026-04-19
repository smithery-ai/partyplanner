import type {
  DispatchResult,
  QueueEvent,
  Registry,
  RunState,
} from "@workflow/core";

export type WorkflowRef = {
  workflowId: string;
  version: string;
  codeHash?: string;
};

export type WorkflowDefinition = {
  ref: WorkflowRef;
  registry: Registry;
};

export type StoredRunState = {
  state: RunState;
  version: number;
};

export type SaveResult =
  | { ok: true; version: number }
  | { ok: false; reason: "conflict" | "missing" };

export interface StateStore {
  load(runId: string): Promise<StoredRunState | undefined>;
  save(
    runId: string,
    state: RunState,
    expectedVersion?: number,
  ): Promise<SaveResult>;
}

export type QueueItemStatus = "pending" | "running" | "completed" | "failed";

export type QueueItem = {
  event: QueueEvent;
  status: QueueItemStatus;
  enqueuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
};

export type QueueSnapshot = {
  pending: QueueItem[];
  running: QueueItem[];
  completed: QueueItem[];
  failed: QueueItem[];
};

export interface WorkQueue {
  enqueue(event: QueueEvent): Promise<void>;
  enqueueMany(events: QueueEvent[]): Promise<void>;
}

export interface InspectableWorkQueue extends WorkQueue {
  dequeue(): Promise<QueueItem | undefined>;
  complete(eventId: string): Promise<void>;
  fail(eventId: string, error: Error): Promise<void>;
  snapshot(): Promise<QueueSnapshot>;
  size(): Promise<number>;
}

export type RunEvent =
  | { type: "run_started"; runId: string; at: number }
  | { type: "input_received"; runId: string; inputId: string; at: number }
  | { type: "node_queued"; runId: string; nodeId: string; at: number }
  | { type: "node_started"; runId: string; nodeId: string; at: number }
  | {
      type: "edge_discovered";
      runId: string;
      source: string;
      target: string;
      at: number;
    }
  | { type: "node_resolved"; runId: string; nodeId: string; at: number }
  | {
      type: "node_skipped";
      runId: string;
      nodeId: string;
      reason?: string;
      at: number;
    }
  | {
      type: "node_waiting";
      runId: string;
      nodeId: string;
      waitingOn: string;
      at: number;
    }
  | {
      type: "node_blocked";
      runId: string;
      nodeId: string;
      blockedOn: string;
      at: number;
    }
  | {
      type: "node_errored";
      runId: string;
      nodeId: string;
      message: string;
      at: number;
    }
  | { type: "run_completed"; runId: string; at: number }
  | { type: "run_waiting"; runId: string; waitingOn: string[]; at: number };

export interface EventSink {
  publish(event: RunEvent): Promise<void>;
  publishMany(events: RunEvent[]): Promise<void>;
}

export interface WorkflowLoader {
  load(ref: WorkflowRef): Promise<WorkflowDefinition>;
}

export type ExecuteRequest = {
  workflow: WorkflowRef;
  registry: Registry;
  event: QueueEvent;
  state: RunState;
};

export type ExecuteResult = DispatchResult;

export interface Executor {
  execute(request: ExecuteRequest): Promise<ExecuteResult>;
}

export type ExecutionStatus =
  | "not_reached"
  | "queued"
  | "running"
  | "resolved"
  | "skipped"
  | "waiting"
  | "blocked"
  | "errored";

export type GraphNode = {
  id: string;
  kind: "input" | "deferred_input" | "atom";
  secret?: boolean;
  description?: string;
  status: ExecutionStatus;
  value?: unknown;
  deps: string[];
  blockedOn?: string;
  waitingOn?: string;
  skipReason?: string;
  attempts: number;
};

export type GraphEdge = {
  id: string;
  source: string;
  target: string;
};

export type RunSnapshot = {
  runId: string;
  workflow: WorkflowRef;
  status:
    | "created"
    | "running"
    | "waiting"
    | "completed"
    | "failed"
    | "canceled";
  nodes: GraphNode[];
  edges: GraphEdge[];
  queue: QueueSnapshot;
  state: RunState;
  version: number;
};

export type StartRunRequest = {
  workflow: WorkflowRef;
  runId?: string;
  input?: {
    inputId: string;
    payload: unknown;
    eventId?: string;
  };
  additionalInputs?: {
    inputId: string;
    payload: unknown;
    eventId?: string;
  }[];
};

export type SubmitInputRequest = {
  runId: string;
  inputId: string;
  payload: unknown;
  eventId?: string;
  workflow?: WorkflowRef;
};

export interface Scheduler {
  startRun(request: StartRunRequest): Promise<RunSnapshot>;
  submitInput(request: SubmitInputRequest): Promise<RunSnapshot>;
  processNext(): Promise<void>;
  drain(): Promise<void>;
  processEvent(event: QueueEvent): Promise<void>;
  snapshot(runId: string): Promise<RunSnapshot>;
}
