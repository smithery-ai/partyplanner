import { PlatformApiError } from "../errors";
import type { BackendAppEnv } from "../types";
import { firstNonEmpty, isRecord, safeJsonParse } from "../utils";
import { assertCompatibilityDate } from "./ids";
import type {
  CloudflareEnvelope,
  CloudflarePlatformConfig,
  ProvisionDeploymentInput,
} from "./types";

const CLOUDFLARE_API_TIMEOUT_MS = 15_000;
const CLOUDFLARE_API_RETRIES = 1;
const REQUIRED_TENANT_WORKER_COMPATIBILITY_FLAGS = [
  "global_fetch_strictly_public",
];

export function resolveCloudflarePlatformConfig(
  env: BackendAppEnv,
): CloudflarePlatformConfig {
  const accountId = firstNonEmpty(env.CLOUDFLARE_ACCOUNT_ID, env.CF_ACCOUNT_ID);
  const apiToken = firstNonEmpty(env.CLOUDFLARE_API_TOKEN, env.CF_API_TOKEN);
  const dispatchNamespace = firstNonEmpty(
    env.CLOUDFLARE_DISPATCH_NAMESPACE,
    env.CF_DISPATCH_NAMESPACE,
  );
  const missing = [
    ["CLOUDFLARE_ACCOUNT_ID", accountId],
    ["CLOUDFLARE_API_TOKEN", apiToken],
    ["CLOUDFLARE_DISPATCH_NAMESPACE", dispatchNamespace],
  ]
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missing.length > 0) {
    throw new PlatformApiError(
      503,
      "deployments_not_configured",
      `Workers for Platforms provisioning is missing required environment variables: ${missing.join(
        ", ",
      )}.`,
    );
  }

  const defaultCompatibilityDate =
    env.CLOUDFLARE_WORKER_COMPATIBILITY_DATE?.trim() || "2026-04-19";
  assertCompatibilityDate(defaultCompatibilityDate);

  return {
    accountId,
    apiToken,
    dispatchNamespace,
    apiBaseUrl:
      env.CLOUDFLARE_API_BASE_URL?.trim().replace(/\/+$/, "") ||
      "https://api.cloudflare.com/client/v4",
    defaultCompatibilityDate,
    workerDispatchBaseUrl: env.HYLO_WORKER_DISPATCH_BASE_URL?.trim(),
  };
}

export function isCloudflarePlatformConfigured(env: BackendAppEnv): boolean {
  return Boolean(
    firstNonEmpty(env.CLOUDFLARE_ACCOUNT_ID, env.CF_ACCOUNT_ID) &&
      firstNonEmpty(env.CLOUDFLARE_API_TOKEN, env.CF_API_TOKEN) &&
      firstNonEmpty(
        env.CLOUDFLARE_DISPATCH_NAMESPACE,
        env.CF_DISPATCH_NAMESPACE,
      ),
  );
}

export function createDeploymentMetadata(
  input: ProvisionDeploymentInput,
  backendUrl: string,
) {
  const metadata: Record<string, unknown> = {
    main_module: input.moduleName,
    compatibility_date: input.compatibilityDate,
    tags: input.tags,
  };
  const compatibilityFlags = tenantWorkerCompatibilityFlags(
    input.compatibilityFlags,
  );
  if (compatibilityFlags.length > 0) {
    metadata.compatibility_flags = compatibilityFlags;
  }
  const bindings = [
    ...(input.bindings ?? []),
    ...workflowBindings(input, backendUrl),
  ];
  if (bindings.length > 0) {
    metadata.bindings = bindings;
  }
  return metadata;
}

function tenantWorkerCompatibilityFlags(flags: string[] = []): string[] {
  return Array.from(
    new Set([...flags, ...REQUIRED_TENANT_WORKER_COMPATIBILITY_FLAGS]),
  );
}

function workflowBindings(
  input: ProvisionDeploymentInput,
  backendUrl: string,
): Record<string, unknown>[] {
  const bindings = [
    plainTextBinding(
      "HYLO_WORKFLOW_ID",
      input.workflowId ?? input.deploymentId,
    ),
    plainTextBinding(
      "HYLO_WORKFLOW_NAME",
      input.workflowName ?? input.label ?? input.deploymentId,
    ),
    plainTextBinding("HYLO_WORKFLOW_VERSION", input.workflowVersion ?? "0.0.0"),
    plainTextBinding("HYLO_BACKEND_URL", backendUrl.replace(/\/+$/, "")),
  ];
  const appUrl = appBaseUrlFromWorkflowApiUrl(input.workflowApiUrl);
  if (appUrl) bindings.push(plainTextBinding("HYLO_APP_URL", appUrl));
  return bindings;
}

// Derive the tenant worker's external app base URL from its workflowApiUrl.
// Brokered OAuth handoff routes are mounted under `/api/workflow/integrations`,
// so the app URL is the workflowApiUrl minus the trailing `/api/workflow`.
function appBaseUrlFromWorkflowApiUrl(
  workflowApiUrl: string | undefined,
): string | undefined {
  if (!workflowApiUrl) return undefined;
  return workflowApiUrl.replace(/\/+$/, "").replace(/\/api\/workflow$/, "");
}

function plainTextBinding(name: string, text: string): Record<string, unknown> {
  return { name, text, type: "plain_text" };
}

export async function cloudflareApiRequest<T>(
  config: CloudflarePlatformConfig,
  path: string,
  init: RequestInit = {},
): Promise<CloudflareEnvelope<T>> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= CLOUDFLARE_API_RETRIES; attempt++) {
    try {
      const response = await fetchCloudflare(config, path, init);
      const envelope = await parseCloudflareEnvelope<T>(response);
      if (
        shouldRetryCloudflare(response, envelope) &&
        attempt < CLOUDFLARE_API_RETRIES
      ) {
        await sleep(retryDelayMs(response));
        continue;
      }
      if (!response.ok || envelope.success === false) {
        throw new PlatformApiError(
          502,
          "cloudflare_api_error",
          `Cloudflare API request failed with HTTP ${response.status}.`,
          {
            status: response.status,
            errors: envelope.errors,
            messages: envelope.messages,
          },
        );
      }
      return envelope;
    } catch (error) {
      lastError = error;
      if (
        attempt >= CLOUDFLARE_API_RETRIES ||
        error instanceof PlatformApiError
      ) {
        throw error;
      }
      await sleep(250);
    }
  }
  throw lastError;
}

async function fetchCloudflare(
  config: CloudflarePlatformConfig,
  path: string,
  init: RequestInit,
) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${config.apiToken}`);
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), CLOUDFLARE_API_TIMEOUT_MS);
  try {
    return await fetch(`${config.apiBaseUrl}${path}`, {
      ...init,
      headers,
      signal: abort.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function parseCloudflareEnvelope<T>(
  response: Response,
): Promise<CloudflareEnvelope<T>> {
  const text = await response.text();
  const parsed = text ? safeJsonParse(text) : {};
  return isRecord(parsed)
    ? (parsed as CloudflareEnvelope<T>)
    : { result: parsed as T };
}

function shouldRetryCloudflare<T>(
  response: Response,
  envelope: CloudflareEnvelope<T>,
): boolean {
  return (
    response.status === 429 ||
    response.status >= 500 ||
    envelope.success === false
  );
}

function retryDelayMs(response: Response): number {
  const retryAfter = response.headers.get("Retry-After");
  if (!retryAfter) return 250;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const timestamp = Date.parse(retryAfter);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : 250;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
