import type { RunEvent, RunSnapshot } from "@rxwf/runtime";
import type { WorkflowManifest } from "./workflow-manifest";

export type CreateWorkflowRequest = {
  workflowSource: string;
  workflowId?: string;
  name?: string;
};

export type DeleteWorkflowResponse = {
  ok: true;
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

export type StartBackendRunRequest = {
  workflowSource: string;
  inputId: string;
  payload: unknown;
  additionalInputs?: {
    inputId: string;
    payload: unknown;
  }[];
  runId?: string;
  autoAdvance?: boolean;
};

export type SubmitBackendInputRequest = {
  inputId: string;
  payload: unknown;
  autoAdvance?: boolean;
};

export type SetAutoAdvanceRequest = {
  autoAdvance: boolean;
};

export type RunStateDocument = RunSnapshot & {
  events: RunEvent[];
  publishedAt: number;
  workflowSource: string;
  autoAdvance: boolean;
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

export type { WorkflowManifest };
