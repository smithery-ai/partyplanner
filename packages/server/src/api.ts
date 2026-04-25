import type { RunEvent, RunSnapshot } from "@workflow/runtime";
import type { WorkflowManagedConnectionManifest } from "./manifest";

export type StartWorkflowRunRequest = {
  inputId?: string;
  payload?: unknown;
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
  restart?: boolean;
};

export type ClearManagedConnectionRequest = Record<string, never>;

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

export type SubmitBackendInputRequest = {
  inputId: string;
  payload: unknown;
  secretValues?: Record<string, string>;
};

export type SubmitBackendWebhookRequest = {
  payload: unknown;
  runId?: string;
};

export type SubmitBackendInterventionRequest = {
  payload: unknown;
  secretValues?: Record<string, string>;
};

export type SecretVaultScope = "user" | "organization";

export type SecretVaultEntry = {
  id: string;
  organizationId: string;
  ownerUserId?: string;
  scope: SecretVaultScope;
  name: string;
  key?: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
};

export type CreateSecretVaultEntryRequest = {
  name: string;
  value: string;
  key?: string;
  scope?: SecretVaultScope;
};

export type UpdateSecretVaultEntryRequest = {
  name?: string;
  value?: string;
  key?: string;
  scope?: SecretVaultScope;
};

export type RunSecretBinding = {
  runId: string;
  workflowId: string;
  organizationId: string;
  logicalName: string;
  vaultEntryId: string;
  boundByUserId: string;
  createdAt: number;
};

export type BindRunSecretRequest = {
  vaultEntryId: string;
};

export type RunStateDocument = RunSnapshot & {
  events: RunEvent[];
  publishedAt: number;
};

export type WorkflowConfigurationDocument = {
  runId: string;
  ready: boolean;
  connections: WorkflowManagedConnectionConfiguration[];
  run?: RunStateDocument;
};

export type RunSummary = {
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
