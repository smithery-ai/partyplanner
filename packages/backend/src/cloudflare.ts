import { createDefaultCloudflareDeploymentBackend } from "./deployments/cloudflare-backend";
import type { WorkflowDeploymentRegistry } from "./deployments/registry";
import type { BackendAppEnv } from "./types";

export { createDefaultCloudflareDeploymentBackend };

export function createCloudflareBackendOptions(
  env: BackendAppEnv,
  registry?: WorkflowDeploymentRegistry,
) {
  return {
    env,
    deploymentBackend: createDefaultCloudflareDeploymentBackend(env, registry),
  };
}
