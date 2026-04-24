import type { BackendAppEnv } from "../types";
import type {
  CloudflarePlatformConfig,
  ProvisionDeploymentInput,
} from "./types";

export type DeploymentBackend = {
  namespace: string;
  configured: boolean;
  config: CloudflarePlatformConfig;
  resolveWorkflowApiUrl(input: ProvisionDeploymentInput): string | undefined;
  create(
    input: ProvisionDeploymentInput,
    requestOrigin: string,
  ): Promise<unknown>;
  list(tag?: string): Promise<DeploymentBackendListResult>;
  get(deploymentId: string): Promise<unknown>;
  delete(deploymentId: string): Promise<unknown>;
  deleteMany(tag: string): Promise<unknown>;
  fetchWorkflow(deploymentId: string, request: Request): Promise<Response>;
};

export type DeploymentBackendListResult = {
  deployments: unknown[];
  resultInfo?: unknown;
};

export type DeploymentBackendFactory = (
  env: BackendAppEnv,
) => DeploymentBackend;
