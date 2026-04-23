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
  HYLO_WORKER_DISPATCH_BASE_URL?: string;
  NODE_ENV?: string;
  NOTION_CLIENT_ID?: string;
  NOTION_CLIENT_SECRET?: string;
  SPOTIFY_CLIENT_ID?: string;
  SPOTIFY_CLIENT_SECRET?: string;
};

export function createApp(
  db: WorkflowCloudflareDbLike,
  env: BackendAppEnv = {},
  deploymentDb?: WorkflowDeploymentRegistryDb,
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
    extraTags: [
      {
        name: "Deployments",
        description:
          "Provision and manage tenant Workers for Platforms scripts.",
      },
      {
        name: "Tenants",
        description: "Read tenant-specific workflow deployment registry data.",
      },
    ],
    extraPaths: createDeploymentOpenApiPaths(),
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

  mountDeploymentApi(app, env, apiKey, deploymentDb);

  return app;
}

type CloudflarePlatformConfig = {
  accountId: string;
  apiBaseUrl: string;
  apiToken: string;
  dispatchNamespace: string;
  defaultCompatibilityDate: string;
  workerDispatchBaseUrl?: string;
};

type CloudflareEnvelope<T> = {
  success?: boolean;
  errors?: unknown[];
  messages?: unknown[];
  result?: T;
  result_info?: unknown;
};

type PlatformErrorStatus = 400 | 401 | 500 | 502 | 503;

type WorkflowDeploymentRegistryDb = {
  prepare(query: string): D1PreparedStatement;
};

type WorkflowDeploymentRecord = {
  tenantId: string;
  deploymentId: string;
  label?: string;
  workflowApiUrl?: string;
  dispatchNamespace: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
};

type ProvisionDeploymentInput = {
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

function mountDeploymentApi(
  app: Hono,
  env: BackendAppEnv,
  apiKey: string,
  deploymentDb?: WorkflowDeploymentRegistryDb,
) {
  app.get("/tenants/:tenantId/deployments", async (c) => {
    try {
      const tenantId = parseTenantIdParam(c.req.param("tenantId"));
      const registry = requireWorkflowDeploymentRegistry(deploymentDb);
      return c.json({
        ok: true,
        tenantId,
        deployments: await registry.list(tenantId),
      });
    } catch (e) {
      return apiErrorResponse(c, e);
    }
  });

  app.get("/tenants/:tenantId/workflows", async (c) => {
    try {
      const tenantId = parseTenantIdParam(c.req.param("tenantId"));
      const registry = requireWorkflowDeploymentRegistry(deploymentDb);
      const deployments = await registry.list(tenantId);
      const workflows = Object.fromEntries(
        deployments
          .filter((deployment) => deployment.workflowApiUrl)
          .map((deployment) => [
            deployment.deploymentId,
            {
              ...(deployment.label ? { label: deployment.label } : {}),
              url: deployment.workflowApiUrl,
            },
          ]),
      );
      return c.json({
        defaultWorkflow: Object.keys(workflows)[0],
        tenantId,
        workflows,
      });
    } catch (e) {
      return apiErrorResponse(c, e);
    }
  });

  app.get("/deployments", async (c) => {
    const unauthorized = requireBearerAuth(c, apiKey);
    if (unauthorized) return unauthorized;

    try {
      const config = resolveCloudflarePlatformConfig(env);
      const tagFilter = parseDeploymentTagFilter(c);
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
        deployments: response.result ?? [],
        resultInfo: response.result_info,
      });
    } catch (e) {
      return apiErrorResponse(c, e);
    }
  });

  app.post("/deployments", async (c) => {
    const unauthorized = requireBearerAuth(c, apiKey);
    if (unauthorized) return unauthorized;

    try {
      const config = resolveCloudflarePlatformConfig(env);
      const body = await readJsonBody(c);
      const input = parseProvisionDeploymentInput(body, config);
      const metadata = createDeploymentMetadata(input);
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
        )}/scripts/${encodeURIComponent(input.deploymentId)}`,
        {
          method: "PUT",
          body: formData,
        },
      );
      if (deploymentDb) {
        await createWorkflowDeploymentRegistry(deploymentDb).upsert({
          tenantId: input.tenantId,
          deploymentId: input.deploymentId,
          label: input.label,
          workflowApiUrl: input.workflowApiUrl,
          dispatchNamespace: config.dispatchNamespace,
          tags: input.tags,
        });
      }

      return c.json(
        {
          ok: true,
          tenantId: input.tenantId,
          deploymentId: input.deploymentId,
          namespace: config.dispatchNamespace,
          workflowApiUrl: input.workflowApiUrl,
          tags: input.tags,
          result: response.result ?? null,
        },
        201,
      );
    } catch (e) {
      return apiErrorResponse(c, e);
    }
  });

  app.delete("/deployments", async (c) => {
    const unauthorized = requireBearerAuth(c, apiKey);
    if (unauthorized) return unauthorized;

    try {
      const config = resolveCloudflarePlatformConfig(env);
      const tagFilter = parseDeploymentTagFilter(c);
      if (!tagFilter) {
        throw new PlatformApiError(
          400,
          "missing_filter",
          "Provide tenantId or tag to delete deployments in bulk.",
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
      if (deploymentDb) {
        const registry = createWorkflowDeploymentRegistry(deploymentDb);
        const tenantId = c.req.query("tenantId")?.trim();
        if (tenantId) {
          await registry.deleteByTenant(parseTenantIdParam(tenantId));
        } else {
          await registry.deleteByTag(tagFilter);
        }
      }

      return c.json({
        ok: true,
        namespace: config.dispatchNamespace,
        tag: tagFilter,
        result: response.result ?? null,
      });
    } catch (e) {
      return apiErrorResponse(c, e);
    }
  });

  app.get("/deployments/:deploymentId", async (c) => {
    const unauthorized = requireBearerAuth(c, apiKey);
    if (unauthorized) return unauthorized;

    try {
      const config = resolveCloudflarePlatformConfig(env);
      const deploymentId = parseDeploymentIdParam(c.req.param("deploymentId"));
      const response = await cloudflareApiRequest<unknown>(
        config,
        `/accounts/${encodeURIComponent(
          config.accountId,
        )}/workers/dispatch/namespaces/${encodeURIComponent(
          config.dispatchNamespace,
        )}/scripts/${encodeURIComponent(deploymentId)}`,
      );
      return c.json({
        ok: true,
        namespace: config.dispatchNamespace,
        deploymentId,
        deployment: response.result ?? null,
      });
    } catch (e) {
      return apiErrorResponse(c, e);
    }
  });

  app.delete("/deployments/:deploymentId", async (c) => {
    const unauthorized = requireBearerAuth(c, apiKey);
    if (unauthorized) return unauthorized;

    try {
      const config = resolveCloudflarePlatformConfig(env);
      const deploymentId = parseDeploymentIdParam(c.req.param("deploymentId"));
      const response = await cloudflareApiRequest<unknown>(
        config,
        `/accounts/${encodeURIComponent(
          config.accountId,
        )}/workers/dispatch/namespaces/${encodeURIComponent(
          config.dispatchNamespace,
        )}/scripts/${encodeURIComponent(deploymentId)}`,
        { method: "DELETE" },
      );
      if (deploymentDb) {
        await createWorkflowDeploymentRegistry(deploymentDb).delete(
          deploymentId,
        );
      }
      return c.json({
        ok: true,
        namespace: config.dispatchNamespace,
        deploymentId,
        result: response.result ?? null,
      });
    } catch (e) {
      return apiErrorResponse(c, e);
    }
  });
}

function createDeploymentOpenApiPaths(): Record<string, unknown> {
  const authHeader = {
    schema: { type: "string" },
    required: true,
    name: "Authorization",
    in: "header",
    description: "Bearer admin API key.",
  };
  const tenantIdParam = {
    schema: { type: "string" },
    required: true,
    name: "tenantId",
    in: "path",
  };
  const deploymentIdParam = {
    schema: { type: "string" },
    required: true,
    name: "deploymentId",
    in: "path",
  };
  const tenantIdQuery = {
    schema: { type: "string" },
    required: false,
    name: "tenantId",
    in: "query",
    description: "Filter by tenant ID.",
  };
  const tagQuery = {
    schema: { type: "string" },
    required: false,
    name: "tag",
    in: "query",
    description: "Filter by Cloudflare Worker tag.",
  };
  const errorResponse = jsonOpenApiResponse("Error response", {
    type: "object",
    properties: {
      error: { type: "string" },
      message: { type: "string" },
      details: {},
    },
    required: ["error", "message"],
  });
  const okResponse = jsonOpenApiResponse("Operation completed", {
    type: "object",
    properties: { ok: { type: "boolean", enum: [true] } },
    required: ["ok"],
  });
  const workflowDeploymentSchema = {
    type: "object",
    properties: {
      tenantId: { type: "string" },
      deploymentId: { type: "string" },
      label: { type: "string" },
      workflowApiUrl: { type: "string" },
      dispatchNamespace: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
      createdAt: { type: "number" },
      updatedAt: { type: "number" },
    },
    required: [
      "tenantId",
      "deploymentId",
      "dispatchNamespace",
      "tags",
      "createdAt",
      "updatedAt",
    ],
  };

  return {
    "/tenants/{tenantId}/deployments": {
      get: {
        operationId: "listTenantDeployments",
        tags: ["Tenants"],
        summary: "List workflow deployments for a tenant",
        parameters: [tenantIdParam],
        responses: {
          200: jsonOpenApiResponse("Tenant deployment registry entries", {
            type: "object",
            properties: {
              ok: { type: "boolean", enum: [true] },
              tenantId: { type: "string" },
              deployments: {
                type: "array",
                items: workflowDeploymentSchema,
              },
            },
            required: ["ok", "tenantId", "deployments"],
          }),
          400: errorResponse,
          503: errorResponse,
        },
      },
    },
    "/tenants/{tenantId}/workflows": {
      get: {
        operationId: "getTenantWorkflows",
        tags: ["Tenants"],
        summary: "Get the client workflow map for a tenant",
        parameters: [tenantIdParam],
        responses: {
          200: jsonOpenApiResponse("Tenant workflow registry", {
            type: "object",
            properties: {
              defaultWorkflow: { type: "string" },
              tenantId: { type: "string" },
              workflows: {
                type: "object",
                additionalProperties: {
                  type: "object",
                  properties: {
                    label: { type: "string" },
                    url: { type: "string" },
                  },
                  required: ["url"],
                },
              },
            },
            required: ["tenantId", "workflows"],
          }),
          400: errorResponse,
          503: errorResponse,
        },
      },
    },
    "/deployments": {
      get: {
        operationId: "listDeployments",
        tags: ["Deployments"],
        summary: "List Workers for Platforms deployments",
        parameters: [authHeader, tenantIdQuery, tagQuery],
        responses: {
          200: jsonOpenApiResponse("Cloudflare dispatch namespace scripts", {
            type: "object",
            properties: {
              ok: { type: "boolean", enum: [true] },
              namespace: { type: "string" },
              deployments: { type: "array", items: {} },
              resultInfo: {},
            },
            required: ["ok", "namespace", "deployments"],
          }),
          400: errorResponse,
          401: errorResponse,
          503: errorResponse,
        },
      },
      post: {
        operationId: "createDeployment",
        tags: ["Deployments"],
        summary: "Create or update a tenant Worker deployment",
        parameters: [authHeader],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  tenantId: { type: "string" },
                  deploymentId: { type: "string" },
                  scriptName: {
                    type: "string",
                    description: "Deprecated alias for deploymentId.",
                  },
                  label: { type: "string" },
                  workflowApiUrl: { type: "string" },
                  url: {
                    type: "string",
                    description: "Alias for workflowApiUrl.",
                  },
                  moduleName: { type: "string" },
                  moduleCode: { type: "string" },
                  script: { type: "string" },
                  code: { type: "string" },
                  compatibilityDate: { type: "string" },
                  compatibilityFlags: {
                    type: "array",
                    items: { type: "string" },
                  },
                  bindings: {
                    type: "array",
                    items: { type: "object", additionalProperties: true },
                  },
                  tags: { type: "array", items: { type: "string" } },
                },
                required: ["tenantId"],
              },
            },
          },
        },
        responses: {
          201: jsonOpenApiResponse("Deployment provisioned", {
            type: "object",
            properties: {
              ok: { type: "boolean", enum: [true] },
              tenantId: { type: "string" },
              deploymentId: { type: "string" },
              namespace: { type: "string" },
              workflowApiUrl: { type: "string" },
              tags: { type: "array", items: { type: "string" } },
              result: {},
            },
            required: ["ok", "tenantId", "deploymentId", "namespace", "tags"],
          }),
          400: errorResponse,
          401: errorResponse,
          502: errorResponse,
          503: errorResponse,
        },
      },
      delete: {
        operationId: "deleteDeployments",
        tags: ["Deployments"],
        summary: "Delete deployments by tenant or tag",
        parameters: [authHeader, tenantIdQuery, tagQuery],
        responses: {
          200: okResponse,
          400: errorResponse,
          401: errorResponse,
          502: errorResponse,
          503: errorResponse,
        },
      },
    },
    "/deployments/{deploymentId}": {
      get: {
        operationId: "getDeployment",
        tags: ["Deployments"],
        summary: "Get a Workers for Platforms deployment",
        parameters: [authHeader, deploymentIdParam],
        responses: {
          200: jsonOpenApiResponse("Cloudflare dispatch namespace script", {
            type: "object",
            properties: {
              ok: { type: "boolean", enum: [true] },
              namespace: { type: "string" },
              deploymentId: { type: "string" },
              deployment: {},
            },
            required: ["ok", "namespace", "deploymentId"],
          }),
          400: errorResponse,
          401: errorResponse,
          502: errorResponse,
          503: errorResponse,
        },
      },
      delete: {
        operationId: "deleteDeployment",
        tags: ["Deployments"],
        summary: "Delete a Workers for Platforms deployment",
        parameters: [authHeader, deploymentIdParam],
        responses: {
          200: jsonOpenApiResponse("Deployment deleted", {
            type: "object",
            properties: {
              ok: { type: "boolean", enum: [true] },
              namespace: { type: "string" },
              deploymentId: { type: "string" },
              result: {},
            },
            required: ["ok", "namespace", "deploymentId"],
          }),
          400: errorResponse,
          401: errorResponse,
          502: errorResponse,
          503: errorResponse,
        },
      },
    },
  };
}

function jsonOpenApiResponse(
  description: string,
  schema: Record<string, unknown>,
) {
  return {
    description,
    content: {
      "application/json": { schema },
    },
  };
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

function parseProvisionDeploymentInput(
  body: unknown,
  config: CloudflarePlatformConfig,
): ProvisionDeploymentInput {
  if (!isRecord(body)) {
    throw new PlatformApiError(
      400,
      "invalid_body",
      "Expected a JSON object request body.",
    );
  }

  const tenantId = requiredString(body, "tenantId");
  const deploymentId =
    optionalString(body, "deploymentId") ??
    optionalString(body, "scriptName") ??
    deploymentIdForTenant(tenantId);
  assertDeploymentId(deploymentId);

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
  const requestedTags = optionalStringArray(body, "tags") ?? [];
  const tenantTag = tagForTenant(tenantId);
  const tags = uniqueStrings([tenantTag, ...requestedTags]);
  assertWorkerTags(tags);

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
    tags,
  };
}

function createDeploymentMetadata(input: ProvisionDeploymentInput) {
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

function createWorkflowDeploymentRegistry(db: WorkflowDeploymentRegistryDb) {
  return {
    async list(tenantId: string): Promise<WorkflowDeploymentRecord[]> {
      const result = await db
        .prepare(
          `select tenant_id, deployment_id, label, workflow_api_url, dispatch_namespace, tags_json, created_at, updated_at
           from workflow_deployments
           where tenant_id = ?
           order by updated_at desc, deployment_id asc`,
        )
        .bind(tenantId)
        .all<WorkflowDeploymentRow>();
      return (result.results ?? []).map(workflowDeploymentFromRow);
    },

    async upsert(
      deployment: Omit<WorkflowDeploymentRecord, "createdAt" | "updatedAt">,
    ): Promise<void> {
      const now = Date.now();
      await db
        .prepare(
          `insert into workflow_deployments (
             deployment_id, tenant_id, label, workflow_api_url, dispatch_namespace, tags_json, created_at, updated_at
           ) values (?, ?, ?, ?, ?, ?, ?, ?)
           on conflict(deployment_id) do update set
             tenant_id = excluded.tenant_id,
             label = excluded.label,
             workflow_api_url = excluded.workflow_api_url,
             dispatch_namespace = excluded.dispatch_namespace,
             tags_json = excluded.tags_json,
             updated_at = excluded.updated_at`,
        )
        .bind(
          deployment.deploymentId,
          deployment.tenantId,
          deployment.label ?? null,
          deployment.workflowApiUrl ?? null,
          deployment.dispatchNamespace,
          JSON.stringify(deployment.tags),
          now,
          now,
        )
        .run();
    },

    async delete(deploymentId: string): Promise<void> {
      await db
        .prepare("delete from workflow_deployments where deployment_id = ?")
        .bind(deploymentId)
        .run();
    },

    async deleteByTenant(tenantId: string): Promise<void> {
      await db
        .prepare("delete from workflow_deployments where tenant_id = ?")
        .bind(tenantId)
        .run();
    },

    async deleteByTag(tag: string): Promise<void> {
      await db
        .prepare(
          "delete from workflow_deployments where tags_json like ? escape '\\'",
        )
        .bind(`%${escapeLikePattern(JSON.stringify(tag))}%`)
        .run();
    },
  };
}

type WorkflowDeploymentRow = {
  tenant_id: string;
  deployment_id: string;
  label: string | null;
  workflow_api_url: string | null;
  dispatch_namespace: string;
  tags_json: string;
  created_at: number;
  updated_at: number;
};

function workflowDeploymentFromRow(
  row: WorkflowDeploymentRow,
): WorkflowDeploymentRecord {
  return {
    tenantId: row.tenant_id,
    deploymentId: row.deployment_id,
    ...(row.label ? { label: row.label } : {}),
    ...(row.workflow_api_url ? { workflowApiUrl: row.workflow_api_url } : {}),
    dispatchNamespace: row.dispatch_namespace,
    tags: parseJsonArray(row.tags_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function requireWorkflowDeploymentRegistry(
  db: WorkflowDeploymentRegistryDb | undefined,
) {
  if (!db) {
    throw new PlatformApiError(
      503,
      "workflow_deployment_registry_unavailable",
      "Workflow deployment registry storage is not configured.",
    );
  }
  return createWorkflowDeploymentRegistry(db);
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

function parseDeploymentTagFilter(c: Context): string | undefined {
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

function parseDeploymentIdParam(deploymentId: string | undefined): string {
  if (!deploymentId) {
    throw new PlatformApiError(
      400,
      "missing_deployment_id",
      "A deployment ID is required.",
    );
  }
  assertDeploymentId(deploymentId);
  return deploymentId;
}

function parseTenantIdParam(tenantId: string | undefined): string {
  const trimmed = tenantId?.trim();
  if (!trimmed) {
    throw new PlatformApiError(
      400,
      "missing_tenant_id",
      "A tenant ID is required.",
    );
  }
  return trimmed;
}

function resolveDefaultWorkflowApiUrl(
  config: CloudflarePlatformConfig,
  deploymentId: string,
): string | undefined {
  const baseUrl = config.workerDispatchBaseUrl?.replace(/\/+$/, "");
  if (!baseUrl) return undefined;
  return `${baseUrl}/${encodeURIComponent(deploymentId)}/api/workflow`;
}

function assertWorkflowApiUrl(value: string): void {
  if (value.startsWith("/")) return;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" || url.protocol === "http:") return;
  } catch {}
  throw new PlatformApiError(
    400,
    "invalid_workflow_api_url",
    "workflowApiUrl must be an absolute HTTP(S) URL or a root-relative path.",
  );
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

function apiErrorResponse(c: Context, e: unknown): Response {
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

function parseJsonArray(text: string): string[] {
  const parsed = safeJsonParse(text);
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : [];
}

function deploymentIdForTenant(tenantId: string): string {
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

function assertDeploymentId(deploymentId: string): void {
  if (!/^[a-z0-9][a-z0-9-_]{0,62}$/.test(deploymentId)) {
    throw new PlatformApiError(
      400,
      "invalid_deployment_id",
      "deploymentId must be 1-63 lowercase letters, numbers, dashes, or underscores, and start with a letter or number.",
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

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
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
