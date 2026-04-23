export type CloudflarePlatformConfig = {
  accountId: string;
  apiBaseUrl: string;
  apiToken: string;
  dispatchNamespace: string;
  defaultCompatibilityDate: string;
  workerDispatchBaseUrl?: string;
};

export type CloudflareEnvelope<T> = {
  success?: boolean;
  errors?: unknown[];
  messages?: unknown[];
  result?: T;
  result_info?: unknown;
};

export type ProvisionDeploymentInput = {
  tenantId: string;
  deploymentId: string;
  label?: string;
  workflowApiUrl?: string;
  moduleName: string;
  moduleCode: string;
  compatibilityDate: string;
  compatibilityFlags?: string[];
  bindings?: Record<string, unknown>[];
  tags: string[];
};
