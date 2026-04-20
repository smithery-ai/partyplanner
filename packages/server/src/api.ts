import type { RunEvent, RunSnapshot } from "@workflow/runtime";

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
  autoAdvance?: boolean;
};

export type SubmitBackendInputRequest = {
  inputId: string;
  payload: unknown;
  secretValues?: Record<string, string>;
  autoAdvance?: boolean;
};

export type SetAutoAdvanceRequest = {
  autoAdvance: boolean;
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
  autoAdvance?: boolean;
};

export type RunStateDocument = RunSnapshot & {
  events: RunEvent[];
  publishedAt: number;
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
