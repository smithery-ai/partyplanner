import { PlatformApiError } from "../errors";
import { isRecord, uniqueStrings } from "../utils";
import {
  assertCompatibilityDate,
  assertDeploymentId,
  assertModuleName,
  assertWorkerTags,
  deploymentIdForTenant,
  deploymentIdForTenantDeployment,
  tagForTenant,
} from "./ids";
import type {
  CloudflarePlatformConfig,
  ProvisionDeploymentInput,
} from "./types";

export function parseProvisionDeploymentInput(
  body: unknown,
  config: CloudflarePlatformConfig,
  defaultTenantId?: string,
  allowAdvancedOptions = true,
): ProvisionDeploymentInput {
  if (!isRecord(body)) {
    throw new PlatformApiError(
      400,
      "invalid_body",
      "Expected a JSON object request body.",
    );
  }

  const tenantId = optionalString(body, "tenantId") ?? defaultTenantId;
  if (!tenantId) {
    throw new PlatformApiError(
      400,
      "missing_field",
      'Missing required field "tenantId".',
    );
  }
  const requestedDeploymentId =
    optionalString(body, "deploymentId") ??
    optionalString(body, "scriptName") ??
    deploymentIdForTenant(tenantId);
  assertDeploymentId(requestedDeploymentId);
  const deploymentId = allowAdvancedOptions
    ? requestedDeploymentId
    : deploymentIdForTenantDeployment(tenantId, requestedDeploymentId);

  const label = optionalString(body, "label");
  const workflowApiUrl =
    optionalString(body, "workflowApiUrl") ??
    optionalString(body, "url") ??
    resolveDefaultWorkflowApiUrl(config, deploymentId);
  if (workflowApiUrl) assertWorkflowApiUrl(workflowApiUrl);

  const moduleName =
    optionalString(body, "moduleName") ?? `${deploymentId}.mjs`;
  assertModuleName(moduleName);

  const moduleCode =
    optionalSourceString(body, "moduleCode") ??
    optionalSourceString(body, "script") ??
    optionalSourceString(body, "code");
  if (!moduleCode) {
    throw new PlatformApiError(
      400,
      "missing_module_code",
      "Provide moduleCode, script, or code with the Worker module source.",
    );
  }

  const compatibilityDate =
    optionalString(body, "compatibilityDate") ??
    config.defaultCompatibilityDate;
  assertCompatibilityDate(compatibilityDate);

  const compatibilityFlags = optionalStringArray(body, "compatibilityFlags");
  const bindings = optionalObjectArray(body, "bindings");
  if (!allowAdvancedOptions && compatibilityFlags?.length) {
    throw new PlatformApiError(
      403,
      "advanced_options_forbidden",
      "compatibilityFlags can only be set with the admin API key.",
    );
  }
  if (!allowAdvancedOptions && bindings?.length) {
    throw new PlatformApiError(
      403,
      "advanced_options_forbidden",
      "bindings can only be set with the admin API key.",
    );
  }

  const requestedTags = optionalStringArray(body, "tags") ?? [];
  const tenantTag = tagForTenant(tenantId);
  const tags = uniqueStrings([tenantTag, ...requestedTags]);
  assertWorkerTags(tags);
  const workflowId = optionalString(body, "workflowId");
  const workflowName = optionalString(body, "workflowName");
  const workflowVersion = optionalString(body, "workflowVersion");

  return {
    tenantId,
    deploymentId,
    label,
    workflowApiUrl,
    moduleName,
    moduleCode,
    compatibilityDate,
    compatibilityFlags,
    bindings,
    workflowId,
    workflowName,
    workflowVersion,
    tags,
  };
}

export function parseDeploymentIdParam(
  deploymentId: string | undefined,
): string {
  if (!deploymentId) {
    throw new PlatformApiError(
      400,
      "missing_deployment_id",
      "Missing deploymentId path parameter.",
    );
  }
  assertDeploymentId(deploymentId);
  return deploymentId;
}

export function parseTenantIdParam(tenantId: string | undefined): string {
  if (!tenantId?.trim()) {
    throw new PlatformApiError(400, "missing_tenant_id", "Missing tenantId.");
  }
  return tenantId.trim();
}

function resolveDefaultWorkflowApiUrl(
  config: CloudflarePlatformConfig,
  deploymentId: string,
): string | undefined {
  if (!config.workerDispatchBaseUrl) return undefined;
  return `${config.workerDispatchBaseUrl.replace(
    /\/+$/,
    "",
  )}/${encodeURIComponent(deploymentId)}/api/workflow`;
}

function assertWorkflowApiUrl(value: string): void {
  if (value.startsWith("/")) return;

  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error();
  } catch {
    throw new PlatformApiError(
      400,
      "invalid_workflow_api_url",
      "workflowApiUrl must be an absolute HTTP(S) URL or a root-relative path.",
    );
  }
}

function optionalString(
  body: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new PlatformApiError(
      400,
      "invalid_field",
      `Field "${key}" must be a string.`,
    );
  }
  return value.trim() ? value : undefined;
}

function optionalSourceString(
  body: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new PlatformApiError(
      400,
      "invalid_field",
      `Field "${key}" must be a string.`,
    );
  }
  return value.trim() ? value : undefined;
}

function optionalStringArray(
  body: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new PlatformApiError(
      400,
      "invalid_field",
      `Field "${key}" must be an array of strings.`,
    );
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function optionalObjectArray(
  body: Record<string, unknown>,
  key: string,
): Record<string, unknown>[] | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => !isRecord(item))) {
    throw new PlatformApiError(
      400,
      "invalid_field",
      `Field "${key}" must be an array of objects.`,
    );
  }
  return value;
}
