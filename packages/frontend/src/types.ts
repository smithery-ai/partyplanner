import type { RunState } from "@workflow/core";
import type { QueueSnapshot, RunEvent, RunSnapshot } from "@workflow/runtime";
import type {
  BindRunSecretRequest,
  CreateSecretVaultEntryRequest,
  JsonSchema,
  RunSecretBinding,
  RunStateDocument,
  RunSummary,
  SecretVaultEntry,
  SetAutoAdvanceRequest,
  StartWorkflowRunRequest,
  SubmitBackendInputRequest,
  SubmitBackendInterventionRequest,
  UpdateSecretVaultEntryRequest,
  WorkflowInputManifest,
  WorkflowManifest,
} from "@workflow/server";

export type JsonPayload =
  | string
  | number
  | boolean
  | null
  | JsonPayload[]
  | { [key: string]: JsonPayload };

export type {
  BindRunSecretRequest,
  CreateSecretVaultEntryRequest,
  JsonSchema,
  RunSecretBinding,
  RunStateDocument,
  RunSummary,
  SecretVaultEntry,
  SetAutoAdvanceRequest,
  StartWorkflowRunRequest,
  SubmitBackendInputRequest,
  SubmitBackendInterventionRequest,
  UpdateSecretVaultEntryRequest,
  WorkflowInputManifest,
  WorkflowManifest,
};

export type WorkflowRuntimeResult = {
  state: RunState;
  snapshot?: RunSnapshot;
  queue?: QueueSnapshot;
  events?: RunEvent[];
  autoAdvance?: boolean;
};
