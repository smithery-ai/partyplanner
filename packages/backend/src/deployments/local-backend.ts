import { PlatformApiError } from "../errors";
import type { BackendAppEnv } from "../types";
import type { DeploymentBackend } from "./backend";
import type {
  WorkflowDeploymentRecord,
  WorkflowDeploymentRegistry,
} from "./registry";

const LOCAL_DISPATCH_NAMESPACE = "local";
const DEFAULT_WORKFLOW_URL_TEMPLATE =
  "https://{workflow}.localhost/api/workflow";

export function createLocalDeploymentBackend(
  env: BackendAppEnv,
  registry: WorkflowDeploymentRegistry | undefined,
): DeploymentBackend {
  const config = {
    accountId: "local",
    apiBaseUrl: "http://localhost",
    apiToken: "local",
    dispatchNamespace: LOCAL_DISPATCH_NAMESPACE,
    defaultCompatibilityDate:
      env.CLOUDFLARE_WORKER_COMPATIBILITY_DATE?.trim() || "2026-04-19",
  };

  return {
    namespace: LOCAL_DISPATCH_NAMESPACE,
    configured: true,
    config,
    resolveWorkflowApiUrl(input) {
      if (input.workflowApiUrl) return input.workflowApiUrl;
      return `/workers/${encodeURIComponent(input.deploymentId)}/api/workflow`;
    },
    resolveWorkflowTargetUrl(input) {
      if (input.workflowApiUrl && !input.workflowApiUrl.startsWith("/")) {
        return input.workflowApiUrl;
      }
      return targetUrl(
        env,
        input.workflowId ?? input.workflowName ?? input.deploymentId,
      );
    },
    async create() {
      return null;
    },
    async list() {
      return { deployments: [] };
    },
    async get(deploymentId) {
      if (!registry) return null;
      return (await registry.get(deploymentId)) ?? null;
    },
    async delete(deploymentId) {
      if (registry) await registry.delete(deploymentId);
      return null;
    },
    async deleteMany() {
      return null;
    },
    async fetchWorkflow(deploymentId, request) {
      if (!registry) {
        throw new PlatformApiError(
          503,
          "workflow_deployment_registry_unavailable",
          "Workflow deployment registry storage is not configured.",
        );
      }
      const deployment = await registry.get(deploymentId);
      if (!deployment) {
        throw new PlatformApiError(
          404,
          "workflow_deployment_not_found",
          `No local workflow deployment found for ${deploymentId}.`,
        );
      }
      return await fetch(
        rewriteWorkflowRequest(request, targetUrl(env, deployment)),
      );
    },
  };
}

function targetUrl(
  env: BackendAppEnv,
  deploymentOrWorkflowId: WorkflowDeploymentRecord | string,
): string {
  if (
    typeof deploymentOrWorkflowId !== "string" &&
    deploymentOrWorkflowId.workflowTargetUrl
  ) {
    return deploymentOrWorkflowId.workflowTargetUrl;
  }

  const workflowHost = localWorkflowHost(
    typeof deploymentOrWorkflowId === "string"
      ? deploymentOrWorkflowId
      : localWorkflowIdFromDeployment(deploymentOrWorkflowId.deploymentId),
  );
  const template =
    env.HYLO_LOCAL_WORKFLOW_URL_TEMPLATE?.trim() ||
    DEFAULT_WORKFLOW_URL_TEMPLATE;
  return template.replaceAll("{workflow}", workflowHost);
}

function localWorkflowHost(raw: string): string {
  return (
    raw
      .replace(/^@[^/]+\//, "")
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "workflow"
  );
}

function localWorkflowIdFromDeployment(deploymentId: string): string {
  return deploymentId.replace(/-[a-z0-9]{10}$/, "");
}

function rewriteWorkflowRequest(request: Request, workflowApiUrl: string) {
  const requestUrl = new URL(request.url);
  const targetUrl = new URL(workflowApiUrl);
  const routedPath = `/${requestUrl.pathname.split("/").slice(3).join("/")}`;
  const basePath = targetUrl.pathname.replace(/\/+$/, "") || "/";

  if (routedPath === "/" || routedPath === basePath) {
    targetUrl.pathname = basePath;
  } else if (routedPath.startsWith(`${basePath}/`)) {
    targetUrl.pathname = routedPath;
  } else {
    targetUrl.pathname = `${basePath}/${routedPath.replace(/^\/+/, "")}`;
  }
  targetUrl.search = requestUrl.search;
  return new Request(targetUrl, request);
}
