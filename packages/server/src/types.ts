import type { QueueEvent, RunState } from "@workflow/core";
import type {
  EventSink,
  QueueItem,
  QueueSnapshot,
  RunEvent,
  RunSnapshot,
  SaveResult,
  StateStore,
  StoredRunState,
  WorkflowRef,
} from "@workflow/runtime";
import type {
  WorkflowManagedConnectionManifest,
  WorkflowManifest,
} from "./manifest";

export type StartWorkflowRunRequest = {
  inputId: string;
  payload: unknown;
  additionalInputs?: {
    inputId: string;
    payload: unknown;
  }[];
  secretBindings?: Record<string, string | { vaultEntryId: string }>;
  secretValues?: Record<string, string>;
  runId?: string;
};

export type ConnectManagedConnectionRequest = {
  secretValues?: Record<string, string>;
};

export type WorkflowManagedConnectionStatus =
  | "not_connected"
  | "connecting"
  | "connected"
  | "error";

export type WorkflowManagedConnectionConfiguration =
  WorkflowManagedConnectionManifest & {
    status: WorkflowManagedConnectionStatus;
    waitingOn?: string;
  };

export type WorkflowConfigurationDocument = {
  runId: string;
  ready: boolean;
  connections: WorkflowManagedConnectionConfiguration[];
  run?: WorkflowRunDocument;
};

export type SubmitWorkflowInputRequest = {
  inputId: string;
  payload: unknown;
  secretValues?: Record<string, string>;
};

export type SubmitWorkflowWebhookRequest = {
  payload: unknown;
  runId?: string;
};

export type SubmitWorkflowInterventionRequest = {
  payload: unknown;
  secretValues?: Record<string, string>;
};

export type WorkflowRunDocument = RunSnapshot & {
  events: RunEvent[];
  publishedAt: number;
};

export type WorkflowRunSummary = {
  runId: string;
  status: RunSnapshot["status"];
  startedAt: number;
  publishedAt: number;
  triggerInputId?: string;
  workflowId: string;
  version: number;
  nodeCount: number;
  terminalNodeCount: number;
  waitingOn: string[];
  failedNodeCount: number;
};

export interface WorkflowStateStore extends StateStore {
  load(runId: string): Promise<StoredRunState | undefined>;
  save(
    runId: string,
    state: RunState,
    expectedVersion?: number,
  ): Promise<SaveResult>;
  publishEvent(event: RunEvent): Promise<void>;
  publishEvents(events: RunEvent[]): Promise<void>;
  listEvents(runId: string): Promise<RunEvent[]>;
  saveRunDocument(document: WorkflowRunDocument): Promise<void>;
  getRunDocument(runId: string): Promise<WorkflowRunDocument | undefined>;
  listRunSummaries(workflowId?: string): Promise<WorkflowRunSummary[]>;
}

export interface WorkflowQueue {
  enqueue(event: QueueEvent): Promise<void>;
  enqueueMany(events: QueueEvent[]): Promise<void>;
  claimNext(runId: string): Promise<QueueItem | undefined>;
  complete(eventId: string): Promise<void>;
  fail(eventId: string, error: Error): Promise<void>;
  snapshot(runId: string): Promise<QueueSnapshot>;
  size(runId: string): Promise<number>;
}

export interface WorkflowEventSink extends EventSink {
  publish(event: RunEvent): Promise<void>;
  publishMany(events: RunEvent[]): Promise<void>;
}

export type WorkflowServerDefinition = {
  ref: WorkflowRef;
  manifest: WorkflowManifest;
};
