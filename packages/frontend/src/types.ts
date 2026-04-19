import type { RunState } from "@workflow/core";
import type { QueueSnapshot, RunEvent, RunSnapshot } from "@workflow/runtime";
import type {
  BindRunSecretRequest,
  CreateSecretVaultEntryRequest,
  CreateWorkflowRequest,
  DeleteWorkflowResponse,
  RunSecretBinding,
  RunStateDocument,
  RunSummary,
  SecretVaultEntry,
  SetAutoAdvanceRequest,
  StartBackendRunRequest,
  StartWorkflowRunRequest,
  SubmitBackendInputRequest,
  UpdateSecretVaultEntryRequest,
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
  BindRunSecretRequest,
  CreateSecretVaultEntryRequest,
  CreateWorkflowRequest,
  DeleteWorkflowResponse,
  RunSecretBinding,
  RunStateDocument,
  RunSummary,
  SecretVaultEntry,
  SetAutoAdvanceRequest,
  StartBackendRunRequest,
  StartWorkflowRunRequest,
  SubmitBackendInputRequest,
  UpdateSecretVaultEntryRequest,
};

export type WorkflowRuntimeResult = {
  state: RunState;
  snapshot?: RunSnapshot;
  queue?: QueueSnapshot;
  events?: RunEvent[];
  workflowSource?: string;
  autoAdvance?: boolean;
};
