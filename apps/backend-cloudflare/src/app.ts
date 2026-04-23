import {
  createCloudflareBrokerStore,
  createCloudflareWorkflowQueue,
  createCloudflareWorkflowStateStore,
  type WorkflowCloudflareDbLike,
} from "@workflow/cloudflare";
import { notionProvider } from "@workflow/integrations-notion";
import { spotifyProvider } from "@workflow/integrations-spotify";
import type { BrokerProviderRegistration } from "@workflow/oauth-broker";
import { createOAuthBrokerServer } from "@workflow/oauth-broker";
import {
  createRemoteRuntimeServer,
  mountRemoteRuntimeOpenApi,
} from "@workflow/remote";
import type { Context } from "hono";
import { Hono } from "hono";
import { cors } from "hono/cors";

export type BackendAppEnv = {
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_BASE_URL?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_DISPATCH_NAMESPACE?: string;
  CLOUDFLARE_WORKER_COMPATIBILITY_DATE?: string;
  CF_ACCOUNT_ID?: string;
  CF_API_TOKEN?: string;
  CF_DISPATCH_NAMESPACE?: string;
  HYLO_API_KEY?: string;
  HYLO_BACKEND_PUBLIC_URL?: string;
  HYLO_BROKER_BASE_URL?: string;
  NODE_ENV?: string;
  NOTION_CLIENT_ID?: string;
  NOTION_CLIENT_SECRET?: string;
  SPOTIFY_CLIENT_ID?: string;
  SPOTIFY_CLIENT_SECRET?: string;
};

export function createApp(
  db: WorkflowCloudflareDbLike,
  env: BackendAppEnv = {},
) {
  const adapterOptions = { autoMigrate: false };
  const stateStore = createCloudflareWorkflowStateStore(db, adapterOptions);
  const queue = createCloudflareWorkflowQueue(db, adapterOptions);
  const app = new Hono();

  app.use(
    "/*",
    cors({
      origin: "*",
      allowHeaders: ["Content-Type", "Authorization"],
      allowMethods: ["GET", "PUT", "POST", "DELETE", "OPTIONS"],
    }),
  );
  app.get("/health", (c) => c.json({ ok: true }));
  mountRemoteRuntimeOpenApi(app, {
    title: "Hylo Backend Worker API",
    runtimeBasePath: "/runtime",
  });
  app.route(
    "/runtime",
    createRemoteRuntimeServer({
      basePath: "/",
      stateStore,
      queue,
      cors: false,
    }),
  );

  const curatedProviders = collectCuratedProviders(env);
  const apiKey = resolveApiKey(env);
  app.route(
    "/oauth",
    createOAuthBrokerServer({
      brokerBaseUrl: resolveBrokerBaseUrl(env),
      store: createCloudflareBrokerStore(db, adapterOptions),
      authenticateAppToken: (token) =>
        token === apiKey ? { appId: "shared" } : undefined,
      providers: curatedProviders,
    }),
  );

  mountWorkerProvisioningApi(app, env, apiKey);

  return app;
}

type CloudflarePlatformConfig = {
  accountId: string;
  apiBaseUrl: string;
  apiToken: string;
  dispatchNamespace: string;
  defaultCompatibilityDate: string;
};

type CloudflareEnvelope<T> = {
  success?: boolean;
  errors?: unknown[];
  messages?: unknown[];
  result?: T;
  result_info?: unknown;
};

type PlatformErrorStatus = 400 | 401 | 500 | 502 | 503;

type ProvisionWorkerInput = {
  tenantId: string;
  scriptName: string;
  moduleName: string;
  moduleCode: string;
  compatibilityDate: string;
  compatibilityFlags?: string[];
  bindings?: Record<string, unknown>[];
  tags: string[];
};

function mountWorkerProvisioningApi(
  app: Hono,
  env: BackendAppEnv,
  apiKey: string,
) {
  app.get("/platform/workers", async (c) => {
    const unauthorized = requireBearerAuth(c, apiKey);
    if (unauthorized) return unauthorized;

    try {
      const config = resolveCloudflarePlatformConfig(env);
      const tagFilter = parseWorkerTagFilter(c);
      const suffix = tagFilter
        ? `?tags=${encodeURIComponent(`${tagFilter}:yes`)}`
        : "";
      const response = await cloudflareApiRequest<unknown[]>(
        config,
        `/accounts/${encodeURIComponent(
          config.accountId,
        )}/workers/dispatch/namespaces/${encodeURIComponent(
          config.dispatchNamespace,
        )}/scripts${suffix}`,
      );
      return c.json({
        ok: true,
        namespace: config.dispatchNamespace,
        workers: response.result ?? [],
        resultInfo: response.result_info,
      });
    } catch (e) {
      return platformErrorResponse(c, e);
    }
  });

  app.post("/platform/workers", async (c) => {
    const unauthorized = requireBearerAuth(c, apiKey);
    if (unauthorized) return unauthorized;

    try {
      const config = resolveCloudflarePlatformConfig(env);
      const body = await readJsonBody(c);
      const input = parseProvisionWorkerInput(body, config);
      const metadata = createWorkerMetadata(input);
      const formData = new FormData();
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
        )}/scripts/${encodeURIComponent(input.scriptName)}`,
        {
          method: "PUT",
          body: formData,
        },
      );

      return c.json(
        {
          ok: true,
          tenantId: input.tenantId,
          scriptName: input.scriptName,
          namespace: config.dispatchNamespace,
          tags: input.tags,
          result: response.result ?? null,
        },
        201,
      );
    } catch (e) {
      return platformErrorResponse(c, e);
    }
  });

  app.delete("/platform/workers", async (c) => {
    const unauthorized = requireBearerAuth(c, apiKey);
    if (unauthorized) return unauthorized;

    try {
      const config = resolveCloudflarePlatformConfig(env);
      const tagFilter = parseWorkerTagFilter(c);
      if (!tagFilter) {
        throw new PlatformApiError(
          400,
          "missing_filter",
          "Provide tenantId or tag to delete Workers in bulk.",
        );
      }

      const response = await cloudflareApiRequest<unknown>(
        config,
        `/accounts/${encodeURIComponent(
          config.accountId,
        )}/workers/dispatch/namespaces/${encodeURIComponent(
          config.dispatchNamespace,
        )}/scripts?tags=${encodeURIComponent(`${tagFilter}:yes`)}`,
        { method: "DELETE" },
      );

      return c.json({
        ok: true,
        namespace: config.dispatchNamespace,
        tag: tagFilter,
        result: response.result ?? null,
      });
    } catch (e) {
      return platformErrorResponse(c, e);
    }
  });

  app.get("/platform/workers/:scriptName", async (c) => {
    const unauthorized = requireBearerAuth(c, apiKey);
    if (unauthorized) return unauthorized;

    try {
      const config = resolveCloudflarePlatformConfig(env);
      const scriptName = parseScriptNameParam(c.req.param("scriptName"));
      const response = await cloudflareApiRequest<unknown>(
        config,
        `/accounts/${encodeURIComponent(
          config.accountId,
        )}/workers/dispatch/namespaces/${encodeURIComponent(
          config.dispatchNamespace,
        )}/scripts/${encodeURIComponent(scriptName)}`,
      );
      return c.json({
        ok: true,
        namespace: config.dispatchNamespace,
        scriptName,
        worker: response.result ?? null,
      });
    } catch (e) {
      return platformErrorResponse(c, e);
    }
  });

  app.delete("/platform/workers/:scriptName", async (c) => {
    const unauthorized = requireBearerAuth(c, apiKey);
    if (unauthorized) return unauthorized;

    try {
      const config = resolveCloudflarePlatformConfig(env);
      const scriptName = parseScriptNameParam(c.req.param("scriptName"));
      const response = await cloudflareApiRequest<unknown>(
        config,
        `/accounts/${encodeURIComponent(
          config.accountId,
        )}/workers/dispatch/namespaces/${encodeURIComponent(
          config.dispatchNamespace,
        )}/scripts/${encodeURIComponent(scriptName)}`,
        { method: "DELETE" },
      );
      return c.json({
        ok: true,
        namespace: config.dispatchNamespace,
        scriptName,
        result: response.result ?? null,
      });
    } catch (e) {
      return platformErrorResponse(c, e);
    }
  });
}

function resolveCloudflarePlatformConfig(
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
      "platform_not_configured",
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
  };
}

function parseProvisionWorkerInput(
  body: unknown,
  config: CloudflarePlatformConfig,
): ProvisionWorkerInput {
  if (!isRecord(body)) {
    throw new PlatformApiError(
      400,
      "invalid_body",
      "Expected a JSON object request body.",
    );
  }

  const tenantId = requiredString(body, "tenantId");
  const scriptName =
    optionalString(body, "scriptName") ?? scriptNameForTenant(tenantId);
  assertScriptName(scriptName);

  const moduleName = optionalString(body, "moduleName") ?? `${scriptName}.mjs`;
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
  const requestedTags = optionalStringArray(body, "tags") ?? [];
  const tenantTag = tagForTenant(tenantId);
  const tags = uniqueStrings([tenantTag, ...requestedTags]);
  assertWorkerTags(tags);

  return {
    tenantId,
    scriptName,
    moduleName,
    moduleCode,
    compatibilityDate,
    compatibilityFlags,
    bindings,
    tags,
  };
}

function createWorkerMetadata(input: ProvisionWorkerInput) {
  const metadata: Record<string, unknown> = {
    main_module: input.moduleName,
    compatibility_date: input.compatibilityDate,
    tags: input.tags,
  };
  if (input.compatibilityFlags && input.compatibilityFlags.length > 0) {
    metadata.compatibility_flags = input.compatibilityFlags;
  }
  if (input.bindings && input.bindings.length > 0) {
    metadata.bindings = input.bindings;
  }
  return metadata;
}

async function cloudflareApiRequest<T>(
  config: CloudflarePlatformConfig,
  path: string,
  init: RequestInit = {},
): Promise<CloudflareEnvelope<T>> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${config.apiToken}`);
  const response = await fetch(`${config.apiBaseUrl}${path}`, {
    ...init,
    headers,
  });
  const text = await response.text();
  const parsed = text ? safeJsonParse(text) : {};
  const envelope: CloudflareEnvelope<T> = isRecord(parsed)
    ? (parsed as CloudflareEnvelope<T>)
    : { result: parsed as T };

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
}

async function readJsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new PlatformApiError(
      400,
      "invalid_body",
      "Expected a valid JSON request body.",
    );
  }
}

function requireBearerAuth(c: Context, apiKey: string): Response | undefined {
  const header = c.req.header("Authorization");
  const match = header?.match(/^Bearer\s+(.+)$/i);
  if (match?.[1]?.trim() === apiKey) return undefined;
  return c.json({ error: "unauthorized" }, 401);
}

function parseWorkerTagFilter(c: Context): string | undefined {
  const tenantId = c.req.query("tenantId")?.trim();
  const tag = c.req.query("tag")?.trim();
  if (tenantId && tag) {
    throw new PlatformApiError(
      400,
      "ambiguous_filter",
      "Provide either tenantId or tag, not both.",
    );
  }
  if (tenantId) return tagForTenant(tenantId);
  if (!tag) return undefined;
  assertWorkerTags([tag]);
  return tag;
}

function parseScriptNameParam(scriptName: string | undefined): string {
  if (!scriptName) {
    throw new PlatformApiError(
      400,
      "missing_script_name",
      "A Worker script name is required.",
    );
  }
  assertScriptName(scriptName);
  return scriptName;
}

class PlatformApiError extends Error {
  readonly status: PlatformErrorStatus;
  readonly code: string;
  readonly details?: unknown;

  constructor(
    status: PlatformErrorStatus,
    code: string,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function platformErrorResponse(c: Context, e: unknown): Response {
  if (e instanceof PlatformApiError) {
    return c.json(
      {
        error: e.code,
        message: e.message,
        ...(e.details === undefined ? {} : { details: e.details }),
      },
      e.status,
    );
  }
  return c.json(
    {
      error: "internal_error",
      message: e instanceof Error ? e.message : "Unknown error",
    },
    500,
  );
}

function firstNonEmpty(...values: (string | undefined)[]): string {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = optionalString(body, key);
  if (!value) {
    throw new PlatformApiError(
      400,
      "missing_field",
      `Missing required field "${key}".`,
    );
  }
  return value;
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
  const trimmed = value.trim();
  return trimmed || undefined;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function scriptNameForTenant(tenantId: string): string {
  const slug = tenantId
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56);
  if (!slug) {
    throw new PlatformApiError(
      400,
      "invalid_tenant_id",
      "tenantId must contain at least one alphanumeric character.",
    );
  }
  return `tenant-${slug}`;
}

function tagForTenant(tenantId: string): string {
  const slug = tenantId
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) {
    throw new PlatformApiError(
      400,
      "invalid_tenant_id",
      "tenantId must contain at least one alphanumeric character.",
    );
  }
  return `tenant-${slug}`;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function assertScriptName(scriptName: string): void {
  if (!/^[a-z0-9][a-z0-9-_]{0,62}$/.test(scriptName)) {
    throw new PlatformApiError(
      400,
      "invalid_script_name",
      "scriptName must be 1-63 lowercase letters, numbers, dashes, or underscores, and start with a letter or number.",
    );
  }
}

function assertModuleName(moduleName: string): void {
  if (!/^[A-Za-z0-9._-]+\.mjs$/.test(moduleName)) {
    throw new PlatformApiError(
      400,
      "invalid_module_name",
      'moduleName must be a simple ".mjs" file name.',
    );
  }
}

function assertCompatibilityDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new PlatformApiError(
      400,
      "invalid_compatibility_date",
      "compatibilityDate must use YYYY-MM-DD format.",
    );
  }
}

function assertWorkerTags(tags: string[]): void {
  if (tags.length > 8) {
    throw new PlatformApiError(
      400,
      "too_many_tags",
      "Cloudflare Workers for Platforms supports at most eight tags per script.",
    );
  }
  for (const tag of tags) {
    if (tag.length === 0 || tag.includes(",") || tag.includes("&")) {
      throw new PlatformApiError(
        400,
        "invalid_tag",
        'Worker tags cannot be empty or contain "," or "&".',
      );
    }
  }
}

function collectCuratedProviders(
  env: BackendAppEnv,
): BrokerProviderRegistration[] {
  const registrations: BrokerProviderRegistration[] = [];
  const catalog = [
    { spec: spotifyProvider, envPrefix: "SPOTIFY" },
    { spec: notionProvider, envPrefix: "NOTION" },
  ];
  for (const { spec, envPrefix } of catalog) {
    const clientId = env[`${envPrefix}_CLIENT_ID` as keyof BackendAppEnv];
    const clientSecret =
      env[`${envPrefix}_CLIENT_SECRET` as keyof BackendAppEnv];
    if (clientId && clientSecret) {
      registrations.push({ spec, clientId, clientSecret });
    }
  }
  return registrations;
}

const DEV_API_KEY = "local-dev-hylo-api-key";

function resolveApiKey(env: BackendAppEnv): string {
  const explicit = env.HYLO_API_KEY?.trim();
  if (explicit) return explicit;
  if (env.NODE_ENV === "production") {
    throw new Error(
      "HYLO_API_KEY is required to mount the OAuth broker in production. Set it in the backend Worker environment.",
    );
  }
  console.warn(
    `[oauth-broker] HYLO_API_KEY is not set; using dev default "${DEV_API_KEY}". Set HYLO_API_KEY in both backend and worker env to override.`,
  );
  return DEV_API_KEY;
}

function resolveBrokerBaseUrl(env: BackendAppEnv): string {
  const explicit = env.HYLO_BROKER_BASE_URL?.trim();
  if (explicit) return explicit;
  const backendUrl = env.HYLO_BACKEND_PUBLIC_URL?.trim();
  if (backendUrl) return `${backendUrl.replace(/\/+$/, "")}/oauth`;
  return "https://api-worker.hylo.localhost/oauth";
}

export type AppType = ReturnType<typeof createApp>;
