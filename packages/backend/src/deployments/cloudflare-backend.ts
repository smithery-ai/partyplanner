import { PlatformApiError } from "../errors";
import type { BackendAppEnv } from "../types";
import type { DeploymentBackend } from "./backend";
import {
  cloudflareApiRequest,
  createDeploymentMetadata,
  isCloudflarePlatformConfigured,
  resolveCloudflarePlatformConfig,
} from "./cloudflare";

export function createCloudflareDeploymentBackend(
  env: BackendAppEnv,
): DeploymentBackend {
  const config = resolveCloudflarePlatformConfig(env);
  return {
    namespace: config.dispatchNamespace,
    configured: isCloudflarePlatformConfigured(env),
    config,
    resolveWorkflowApiUrl(input) {
      return input.workflowApiUrl;
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
      if (!env.DISPATCHER) {
        throw new PlatformApiError(
          503,
          "worker_dispatch_not_configured",
          "Worker dispatch namespace binding is not configured.",
        );
      }
      return await env.DISPATCHER.get(deploymentId).fetch(
        rewriteDispatchRequest(request),
      );
    },
  };
}

export function createUnavailableCloudflareDeploymentBackend(
  env: BackendAppEnv,
): DeploymentBackend {
  const missingConfig = missingCloudflareConfig(env);
  return {
    namespace: "unconfigured",
    configured: false,
    config: {
      accountId: "",
      apiBaseUrl: "",
      apiToken: "",
      dispatchNamespace: "",
      defaultCompatibilityDate:
        env.CLOUDFLARE_WORKER_COMPATIBILITY_DATE?.trim() || "2026-04-19",
    },
    resolveWorkflowApiUrl() {
      return undefined;
    },
    create: unavailable,
    list: unavailable,
    get: unavailable,
    delete: unavailable,
    deleteMany: unavailable,
    fetchWorkflow: unavailable,
  };

  function unavailable(): never {
    throw new PlatformApiError(
      503,
      "deployments_not_configured",
      `Workers for Platforms provisioning is missing required environment variables: ${missingConfig.join(
        ", ",
      )}.`,
    );
  }
}

export function createDefaultCloudflareDeploymentBackend(
  env: BackendAppEnv,
): DeploymentBackend {
  return isCloudflarePlatformConfigured(env)
    ? createCloudflareDeploymentBackend(env)
    : createUnavailableCloudflareDeploymentBackend(env);
}

function missingCloudflareConfig(env: BackendAppEnv): string[] {
  const missing = [];
  if (!env.CLOUDFLARE_ACCOUNT_ID?.trim() && !env.CF_ACCOUNT_ID?.trim()) {
    missing.push("CLOUDFLARE_ACCOUNT_ID");
  }
  if (!env.CLOUDFLARE_API_TOKEN?.trim() && !env.CF_API_TOKEN?.trim()) {
    missing.push("CLOUDFLARE_API_TOKEN");
  }
  if (
    !env.CLOUDFLARE_DISPATCH_NAMESPACE?.trim() &&
    !env.CF_DISPATCH_NAMESPACE?.trim()
  ) {
    missing.push("CLOUDFLARE_DISPATCH_NAMESPACE");
  }
  return missing;
}

function rewriteDispatchRequest(request: Request): Request {
  const url = new URL(request.url);
  const path = url.pathname.split("/").slice(3).join("/");
  url.pathname = path ? `/${path}` : "/";
  return new Request(url, request);
}
