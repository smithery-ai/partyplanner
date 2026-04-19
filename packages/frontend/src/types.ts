import type { RunState } from "@workflow/core";
import type { QueueSnapshot, RunEvent, RunSnapshot } from "@workflow/runtime";

export type JsonPayload =
  | string
  | number
  | boolean
  | null
  | JsonPayload[]
  | { [key: string]: JsonPayload };

export type WorkflowInputManifest = {
  id: string;
  kind: "input" | "deferred_input";
  secret?: boolean;
  description?: string;
  schema: Record<string, unknown>;
};

export type WorkflowManifest = {
  workflowId: string;
  version: string;
  codeHash?: string;
  name?: string;
  createdAt: number;
  inputs: WorkflowInputManifest[];
  source?: string;
};

export type CreateWorkflowRequest = {
  workflowSource: string;
  workflowId?: string;
  name?: string;
};

export type DeleteWorkflowResponse = {
  ok: true;
};

export type RunStateDocument = RunSnapshot & {
  state: RunState;
  queue: QueueSnapshot;
  events: RunEvent[];
  publishedAt: number;
  autoAdvance: boolean;
  workflowSource?: string;
};

export type RunSummary = {
  runId: string;
  status: RunSnapshot["status"];
  startedAt: number;
  publishedAt: number;
  workflowId: string;
  version: number;
  nodeCount: number;
  terminalNodeCount: number;
  waitingOn: string[];
  failedNodeCount: number;
};

export type StartWorkflowRunRequest = {
  inputId: string;
  payload: unknown;
  additionalInputs?: {
    inputId: string;
    payload: unknown;
  }[];
  runId?: string;
  autoAdvance?: boolean;
};

export type StartBackendRunRequest = StartWorkflowRunRequest & {
  workflowSource?: string;
};

export type SubmitBackendInputRequest = {
  inputId: string;
  payload: unknown;
  autoAdvance?: boolean;
};

export type SetAutoAdvanceRequest = {
  autoAdvance: boolean;
};

export type WorkflowRuntimeResult = {
  state: RunState;
  snapshot?: RunSnapshot;
  queue?: QueueSnapshot;
  events?: RunEvent[];
  workflowSource?: string;
  autoAdvance?: boolean;
};
