import { createDefaultCloudflareDeploymentBackend } from "./deployments/cloudflare-backend";
import type { BackendAppEnv } from "./types";

export { createDefaultCloudflareDeploymentBackend };

export function createCloudflareBackendOptions(env: BackendAppEnv) {
  return {
    env,
    deploymentBackend: createDefaultCloudflareDeploymentBackend(env),
  };
}
