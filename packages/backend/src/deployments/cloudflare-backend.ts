import { PlatformApiError } from "../errors";
import type { BackendAppEnv } from "../types";
import type { DeploymentBackend } from "./backend";
import {
  cloudflareApiRequest,
  createDeploymentMetadata,
  isCloudflarePlatformConfigured,
  resolveCloudflarePlatformConfig,
} from "./cloudflare";
import { createLocalDeploymentBackend } from "./local-backend";
import type { WorkflowDeploymentRegistry } from "./registry";

export function createCloudflareDeploymentBackend(
  env: BackendAppEnv,
): DeploymentBackend {
  const config = resolveCloudflarePlatformConfig(env);
  return {
    namespace: config.dispatchNamespace,
    configured: isCloudflarePlatformConfigured(env),
    config,
    resolveWorkflowApiUrl(input, requestOrigin) {
      return (
        input.workflowApiUrl ??
        defaultWorkflowApiUrl(
          config.workerDispatchBaseUrl ?? `${requestOrigin}/workers`,
          input.deploymentId,
        )
      );
    },
    resolveWorkflowTargetUrl() {
      return undefined;
    },
    async create(input, requestOrigin) {
      const formData = new FormData();
      const metadata = createDeploymentMetadata(input, requestOrigin);
      formData.append(
        "metadata",
        new Blob([JSON.stringify(metadata)], { type: "application/json" }),
      );
      formData.append(
        input.moduleName,
        new Blob([input.moduleCode], {
          type: "application/javascript+module",
        }),
        input.moduleName,
      );

      const response = await cloudflareApiRequest<unknown>(
        config,
        `/accounts/${encodeURIComponent(
          config.accountId,
        )}/workers/dispatch/namespaces/${encodeURIComponent(
          config.dispatchNamespace,
        )}/scripts/${encodeURIComponent(input.deploymentId)}`,
        {
          method: "PUT",
          body: formData,
        },
      );
      return response.result ?? null;
    },
    async list(tag) {
      const path = tag
        ? `/accounts/${encodeURIComponent(
            config.accountId,
          )}/workers/dispatch/namespaces/${encodeURIComponent(
            config.dispatchNamespace,
          )}/scripts?tags=${encodeURIComponent(`${tag}:yes`)}`
        : `/accounts/${encodeURIComponent(
            config.accountId,
          )}/workers/dispatch/namespaces/${encodeURIComponent(
            config.dispatchNamespace,
          )}/scripts`;
      const response = await cloudflareApiRequest<unknown[]>(config, path);
      return {
        deployments: response.result ?? [],
        resultInfo: response.result_info,
      };
    },
    async get(deploymentId) {
      const response = await cloudflareApiRequest<unknown>(
        config,
        `/accounts/${encodeURIComponent(
          config.accountId,
        )}/workers/dispatch/namespaces/${encodeURIComponent(
          config.dispatchNamespace,
        )}/scripts/${encodeURIComponent(deploymentId)}`,
      );
      return response.result ?? null;
    },
    async delete(deploymentId) {
      const response = await cloudflareApiRequest<unknown>(
        config,
        `/accounts/${encodeURIComponent(
          config.accountId,
        )}/workers/dispatch/namespaces/${encodeURIComponent(
          config.dispatchNamespace,
        )}/scripts/${encodeURIComponent(deploymentId)}`,
        { method: "DELETE" },
      );
      return response.result ?? null;
    },
    async deleteMany(tag) {
      const response = await cloudflareApiRequest<unknown>(
        config,
        `/accounts/${encodeURIComponent(
          config.accountId,
        )}/workers/dispatch/namespaces/${encodeURIComponent(
          config.dispatchNamespace,
        )}/scripts?tags=${encodeURIComponent(`${tag}:yes`)}`,
        { method: "DELETE" },
      );
      return response.result ?? null;
    },
    async fetchWorkflow(deploymentId, request) {
      const dispatcher = env.DISPATCHER;
      if (!dispatcher) {
        throw new PlatformApiError(
          503,
          "worker_dispatch_not_configured",
          "Worker dispatch namespace binding is not configured.",
        );
      }
      return await dispatcher
        .get(deploymentId)
        .fetch(rewriteDispatchRequest(request));
    },
  };
}

export function createDefaultCloudflareDeploymentBackend(
  env: BackendAppEnv,
  registry?: WorkflowDeploymentRegistry,
): DeploymentBackend {
  const provisioning = isCloudflarePlatformConfigured(env)
    ? createCloudflareDeploymentBackend(env)
    : undefined;
  const local = createLocalDeploymentBackend(env, registry);
  const primary = provisioning ?? local;

  return {
    namespace: primary.namespace,
    configured: primary.configured,
    config: primary.config,
    resolveWorkflowApiUrl(input, requestOrigin) {
      return primary.resolveWorkflowApiUrl(input, requestOrigin);
    },
    resolveWorkflowTargetUrl(input, requestOrigin) {
      return primary.resolveWorkflowTargetUrl?.(input, requestOrigin);
    },
    create(input, requestOrigin) {
      return primary.create(input, requestOrigin);
    },
    list(tag) {
      return primary.list(tag);
    },
    get(deploymentId) {
      return primary.get(deploymentId);
    },
    delete(deploymentId) {
      return primary.delete(deploymentId);
    },
    deleteMany(tag) {
      return primary.deleteMany(tag);
    },
    async fetchWorkflow(deploymentId, request) {
      if (env.DISPATCHER) {
        return await env.DISPATCHER.get(deploymentId).fetch(
          rewriteDispatchRequest(request),
        );
      }
      return local.fetchWorkflow(deploymentId, request);
    },
  };
}

function defaultWorkflowApiUrl(baseUrl: string, deploymentId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(
    deploymentId,
  )}/api/workflow`;
}

function rewriteDispatchRequest(request: Request): Request {
  const url = new URL(request.url);
  const path = url.pathname.split("/").slice(3).join("/");
  url.pathname = path ? `/${path}` : "/";
  return new Request(url, request);
}
