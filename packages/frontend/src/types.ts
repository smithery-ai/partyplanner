import type { RunState } from "@workflow/core";
import type { QueueSnapshot, RunEvent, RunSnapshot } from "@workflow/runtime";
import type {
  BindRunSecretRequest,
  ConnectManagedConnectionRequest,
  CreateSecretVaultEntryRequest,
  JsonSchema,
  RunSecretBinding,
  RunStateDocument,
  RunSummary,
  SecretVaultEntry,
  StartWorkflowRunRequest,
  SubmitBackendInputRequest,
  SubmitBackendInterventionRequest,
  SubmitBackendWebhookRequest,
  UpdateSecretVaultEntryRequest,
  WorkflowConfigurationDocument,
  WorkflowInputManifest,
  WorkflowManagedConnectionManifest,
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
  ConnectManagedConnectionRequest,
  CreateSecretVaultEntryRequest,
  JsonSchema,
  RunSecretBinding,
  RunStateDocument,
  RunSummary,
  SecretVaultEntry,
  StartWorkflowRunRequest,
  SubmitBackendInputRequest,
  SubmitBackendInterventionRequest,
  SubmitBackendWebhookRequest,
  UpdateSecretVaultEntryRequest,
  WorkflowConfigurationDocument,
  WorkflowInputManifest,
  WorkflowManagedConnectionManifest,
  WorkflowManifest,
};

export type WorkflowRuntimeResult = {
  state: RunState;
  snapshot?: RunSnapshot;
  queue?: QueueSnapshot;
  events?: RunEvent[];
};
