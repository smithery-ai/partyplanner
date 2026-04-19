import type { RunState } from "@workflow/core";
import type { QueueSnapshot, RunEvent, RunSnapshot } from "@workflow/runtime";
import type {
  CreateWorkflowRequest,
  DeleteWorkflowResponse,
  RunStateDocument,
  RunSummary,
  SetAutoAdvanceRequest,
  StartBackendRunRequest,
  StartWorkflowRunRequest,
  SubmitBackendInputRequest,
  WorkflowApiManifest,
} from "@workflow/server";

export type JsonPayload =
  | string
  | number
  | boolean
  | null
  | JsonPayload[]
  | { [key: string]: JsonPayload };

export type WorkflowManifest = WorkflowApiManifest;

export type {
  CreateWorkflowRequest,
  DeleteWorkflowResponse,
  RunStateDocument,
  RunSummary,
  SetAutoAdvanceRequest,
  StartBackendRunRequest,
  StartWorkflowRunRequest,
  SubmitBackendInputRequest,
};

export type WorkflowRuntimeResult = {
  state: RunState;
  snapshot?: RunSnapshot;
  queue?: QueueSnapshot;
  events?: RunEvent[];
  workflowSource?: string;
  autoAdvance?: boolean;
};
