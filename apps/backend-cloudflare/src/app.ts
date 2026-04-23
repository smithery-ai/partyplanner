import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
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
  createRemoteRuntimeOpenApiDocument,
  createRemoteRuntimeServer,
  mountRemoteRuntimeOpenApi,
  type RemoteRuntimeOpenApiOptions,
} from "@workflow/remote";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";

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
  WORKOS_API_HOSTNAME?: string;
  WORKOS_CLIENT_ID?: string;
  WORKOS_ISSUER?: string;
  WORKOS_JWKS_URL?: string;
};

export function createApp(
  db: WorkflowCloudflareDbLike,
  env: BackendAppEnv = {},
  deploymentDb?: WorkflowDeploymentRegistryDb,
) {
  const adapterOptions = { autoMigrate: false };
  const stateStore = createCloudflareWorkflowStateStore(db, adapterOptions);
  const queue = createCloudflareWorkflowQueue(db, adapterOptions);
  const app = new OpenAPIHono();

  app.use(
    "/*",
    cors({
      origin: "*",
      allowHeaders: ["Content-Type", "Authorization"],
      allowMethods: ["GET", "PUT", "POST", "DELETE", "OPTIONS"],
    }),
  );
  app.get("/health", (c) => c.json({ ok: true }));
  mountRemoteRuntimeOpenApi(app, createBackendOpenApiOptions());
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
  mountAuthApi(app, env, apiKey);
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

export function createBackendOpenApiDocument(): object {
  return createRemoteRuntimeOpenApiDocument(createBackendOpenApiOptions());
}

function createBackendOpenApiOptions(): RemoteRuntimeOpenApiOptions {
  const routeDocument = createBackendRouteOpenApiDocument();
  return {
    title: "Hylo Backend Worker API",
    runtimeBasePath: "/runtime",
    extraTags: [
      {
        name: "Auth",
        description: "Public auth bootstrap and authenticated identity.",
      },
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
    extraComponents: {
      ...((routeDocument.components as Record<string, unknown>) ?? {}),
      securitySchemes: {
        ...(((routeDocument.components as Record<string, unknown> | undefined)
          ?.securitySchemes as Record<string, unknown> | undefined) ?? {}),
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "WorkOS access token or admin API key.",
        },
      },
    },
    extraPaths: (routeDocument.paths as Record<string, unknown>) ?? {},
  };
}

function createBackendRouteOpenApiDocument(): Record<string, unknown> {
  const app = new OpenAPIHono();
  mountBackendOpenApiRoutes(app);
  return app.getOpenAPIDocument({
    openapi: "3.0.3",
    info: {
      title: "Hylo Backend Worker API",
      version: "0.0.0",
    },
  }) as unknown as Record<string, unknown>;
}

function mountBackendOpenApiRoutes(app: OpenAPIHono): void {
  app.openAPIRegistry.registerPath(GetAuthClientConfigRoute);
  app.openAPIRegistry.registerPath(GetCurrentIdentityRoute);
  app.openAPIRegistry.registerPath(ListTenantDeploymentsRoute);
  app.openAPIRegistry.registerPath(GetTenantWorkflowsRoute);
  app.openAPIRegistry.registerPath(ListDeploymentsRoute);
  app.openAPIRegistry.registerPath(CreateDeploymentRoute);
  app.openAPIRegistry.registerPath(DeleteDeploymentsRoute);
  app.openAPIRegistry.registerPath(GetDeploymentRoute);
  app.openAPIRegistry.registerPath(DeleteDeploymentRoute);
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

type PlatformErrorStatus = 400 | 401 | 403 | 500 | 502 | 503;

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

type AuthContext =
  | { kind: "admin" }
  | {
      kind: "workos";
      tenantId: string;
      userId: string;
      role?: string;
      permissions: string[];
    };

type WorkOSAccessTokenClaims = JWTPayload & {
  org_id?: string;
  permissions?: unknown;
  role?: unknown;
};

const JsonContentType = "application/json";
const BearerSecurity = [{ bearerAuth: [] }];

const PlatformErrorResponseSchema = z
  .object({
    error: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  })
  .openapi("PlatformErrorResponse");

const AuthClientConfigSchema = z
  .object({
    auth: z
      .object({
        provider: z.literal("workos"),
        clientId: z.string(),
        apiHostname: z.string(),
      })
      .nullable(),
    api: z.object({
      baseUrl: z.string(),
    }),
    features: z.object({
      cliAuth: z.boolean(),
      deployments: z.boolean(),
    }),
  })
  .openapi("AuthClientConfig");

const CurrentIdentitySchema = z
  .object({
    auth: z.object({
      kind: z.enum(["admin", "workos"]),
    }),
    organization: z.object({ id: z.string() }).optional(),
    permissions: z.array(z.string()).optional(),
    role: z.string().nullable().optional(),
    user: z.object({ id: z.string() }).optional(),
  })
  .openapi("CurrentIdentity");

const WorkflowDeploymentSchema = z
  .object({
    tenantId: z.string(),
    deploymentId: z.string(),
    label: z.string().optional(),
    workflowApiUrl: z.string().optional(),
    dispatchNamespace: z.string(),
    tags: z.array(z.string()),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .openapi("WorkflowDeployment");

const TenantDeploymentsResponseSchema = z
  .object({
    ok: z.literal(true),
    tenantId: z.string(),
    deployments: z.array(WorkflowDeploymentSchema),
  })
  .openapi("TenantDeploymentsResponse");

const TenantWorkflowRegistrySchema = z
  .object({
    defaultWorkflow: z.string().optional(),
    tenantId: z.string(),
    workflows: z.record(
      z.string(),
      z.object({
        label: z.string().optional(),
        url: z.string(),
      }),
    ),
  })
  .openapi("TenantWorkflowRegistry");

const DeploymentFilterQuerySchema = z
  .object({
    tenantId: z.string().optional(),
    tag: z.string().optional(),
  })
  .openapi("DeploymentFilterQuery");

const TenantParamSchema = z.object({
  tenantId: z.string().openapi({
    param: { name: "tenantId", in: "path" },
  }),
});

const DeploymentParamSchema = z.object({
  deploymentId: z.string().openapi({
    param: { name: "deploymentId", in: "path" },
  }),
});

const CreateDeploymentRequestSchema = z
  .object({
    tenantId: z.string().optional(),
    deploymentId: z.string().optional(),
    scriptName: z
      .string()
      .optional()
      .openapi({ description: "Deprecated alias for deploymentId." }),
    label: z.string().optional(),
    workflowApiUrl: z.string().optional(),
    url: z
      .string()
      .optional()
      .openapi({ description: "Alias for workflowApiUrl." }),
    moduleName: z.string().optional(),
    moduleCode: z.string().optional(),
    script: z.string().optional(),
    code: z.string().optional(),
    compatibilityDate: z.string().optional(),
    compatibilityFlags: z.array(z.string()).optional(),
    bindings: z.array(z.record(z.string(), z.unknown())).optional(),
    tags: z.array(z.string()).optional(),
  })
  .openapi("CreateDeploymentRequest");

const ListDeploymentsResponseSchema = z
  .object({
    ok: z.literal(true),
    namespace: z.string(),
    deployments: z.array(z.unknown()),
    resultInfo: z.unknown().optional(),
  })
  .openapi("ListDeploymentsResponse");

const CreateDeploymentResponseSchema = z
  .object({
    ok: z.literal(true),
    tenantId: z.string(),
    deploymentId: z.string(),
    namespace: z.string(),
    workflowApiUrl: z.string().optional(),
    tags: z.array(z.string()),
    result: z.unknown().optional(),
  })
  .openapi("CreateDeploymentResponse");

const DeleteDeploymentsResponseSchema = z
  .object({
    ok: z.literal(true),
    namespace: z.string(),
    tag: z.string().optional(),
    result: z.unknown().optional(),
  })
  .openapi("DeleteDeploymentsResponse");

const GetDeploymentResponseSchema = z
  .object({
    ok: z.literal(true),
    namespace: z.string(),
    deploymentId: z.string(),
    deployment: z.unknown().optional(),
  })
  .openapi("GetDeploymentResponse");

const DeleteDeploymentResponseSchema = z
  .object({
    ok: z.literal(true),
    namespace: z.string(),
    deploymentId: z.string(),
    result: z.unknown().optional(),
  })
  .openapi("DeleteDeploymentResponse");

const GetAuthClientConfigRoute = createRoute({
  method: "get",
  path: "/auth/client-config",
  operationId: "getAuthClientConfig",
  tags: ["Auth"],
  summary: "Get public auth client configuration",
  responses: {
    200: openApiJsonResponse(
      "Public auth client configuration",
      AuthClientConfigSchema,
    ),
  },
});

const GetCurrentIdentityRoute = createRoute({
  method: "get",
  path: "/me",
  operationId: "getCurrentIdentity",
  tags: ["Auth"],
  summary: "Get the authenticated identity",
  security: BearerSecurity,
  responses: {
    200: openApiJsonResponse("Authenticated identity", CurrentIdentitySchema),
    401: openApiJsonResponse(
      "Authentication failed",
      PlatformErrorResponseSchema,
    ),
  },
});

const ListTenantDeploymentsRoute = createRoute({
  method: "get",
  path: "/tenants/{tenantId}/deployments",
  operationId: "listTenantDeployments",
  tags: ["Tenants"],
  summary: "List workflow deployments for a tenant",
  security: BearerSecurity,
  request: { params: TenantParamSchema },
  responses: {
    200: openApiJsonResponse(
      "Tenant deployment registry entries",
      TenantDeploymentsResponseSchema,
    ),
    400: openApiJsonResponse("Invalid request", PlatformErrorResponseSchema),
    503: openApiJsonResponse(
      "Deployment registry unavailable",
      PlatformErrorResponseSchema,
    ),
  },
});

const GetTenantWorkflowsRoute = createRoute({
  method: "get",
  path: "/tenants/{tenantId}/workflows",
  operationId: "getTenantWorkflows",
  tags: ["Tenants"],
  summary: "Get the client workflow map for a tenant",
  security: BearerSecurity,
  request: { params: TenantParamSchema },
  responses: {
    200: openApiJsonResponse(
      "Tenant workflow registry",
      TenantWorkflowRegistrySchema,
    ),
    400: openApiJsonResponse("Invalid request", PlatformErrorResponseSchema),
    503: openApiJsonResponse(
      "Deployment registry unavailable",
      PlatformErrorResponseSchema,
    ),
  },
});

const ListDeploymentsRoute = createRoute({
  method: "get",
  path: "/deployments",
  operationId: "listDeployments",
  tags: ["Deployments"],
  summary: "List Workers for Platforms deployments",
  security: BearerSecurity,
  request: { query: DeploymentFilterQuerySchema },
  responses: {
    200: openApiJsonResponse(
      "Cloudflare dispatch namespace scripts",
      ListDeploymentsResponseSchema,
    ),
    400: openApiJsonResponse("Invalid request", PlatformErrorResponseSchema),
    401: openApiJsonResponse(
      "Authentication failed",
      PlatformErrorResponseSchema,
    ),
    503: openApiJsonResponse(
      "Deployments unavailable",
      PlatformErrorResponseSchema,
    ),
  },
});

const CreateDeploymentRoute = createRoute({
  method: "post",
  path: "/deployments",
  operationId: "createDeployment",
  tags: ["Deployments"],
  summary: "Create or update a tenant Worker deployment",
  security: BearerSecurity,
  request: {
    body: {
      required: true,
      content: {
        [JsonContentType]: { schema: CreateDeploymentRequestSchema },
      },
    },
  },
  responses: {
    201: openApiJsonResponse(
      "Deployment provisioned",
      CreateDeploymentResponseSchema,
    ),
    400: openApiJsonResponse("Invalid request", PlatformErrorResponseSchema),
    401: openApiJsonResponse(
      "Authentication failed",
      PlatformErrorResponseSchema,
    ),
    502: openApiJsonResponse(
      "Cloudflare request failed",
      PlatformErrorResponseSchema,
    ),
    503: openApiJsonResponse(
      "Deployments unavailable",
      PlatformErrorResponseSchema,
    ),
  },
});

const DeleteDeploymentsRoute = createRoute({
  method: "delete",
  path: "/deployments",
  operationId: "deleteDeployments",
  tags: ["Deployments"],
  summary: "Delete deployments by tenant or tag",
  security: BearerSecurity,
  request: { query: DeploymentFilterQuerySchema },
  responses: {
    200: openApiJsonResponse(
      "Deployments deleted",
      DeleteDeploymentsResponseSchema,
    ),
    400: openApiJsonResponse("Invalid request", PlatformErrorResponseSchema),
    401: openApiJsonResponse(
      "Authentication failed",
      PlatformErrorResponseSchema,
    ),
    502: openApiJsonResponse(
      "Cloudflare request failed",
      PlatformErrorResponseSchema,
    ),
    503: openApiJsonResponse(
      "Deployments unavailable",
      PlatformErrorResponseSchema,
    ),
  },
});

const GetDeploymentRoute = createRoute({
  method: "get",
  path: "/deployments/{deploymentId}",
  operationId: "getDeployment",
  tags: ["Deployments"],
  summary: "Get a Workers for Platforms deployment",
  security: BearerSecurity,
  request: { params: DeploymentParamSchema },
  responses: {
    200: openApiJsonResponse(
      "Cloudflare dispatch namespace script",
      GetDeploymentResponseSchema,
    ),
    400: openApiJsonResponse("Invalid request", PlatformErrorResponseSchema),
    401: openApiJsonResponse(
      "Authentication failed",
      PlatformErrorResponseSchema,
    ),
    502: openApiJsonResponse(
      "Cloudflare request failed",
      PlatformErrorResponseSchema,
    ),
    503: openApiJsonResponse(
      "Deployments unavailable",
      PlatformErrorResponseSchema,
    ),
  },
});

const DeleteDeploymentRoute = createRoute({
  method: "delete",
  path: "/deployments/{deploymentId}",
  operationId: "deleteDeployment",
  tags: ["Deployments"],
  summary: "Delete a Workers for Platforms deployment",
  security: BearerSecurity,
  request: { params: DeploymentParamSchema },
  responses: {
    200: openApiJsonResponse(
      "Deployment deleted",
      DeleteDeploymentResponseSchema,
    ),
    400: openApiJsonResponse("Invalid request", PlatformErrorResponseSchema),
    401: openApiJsonResponse(
      "Authentication failed",
      PlatformErrorResponseSchema,
    ),
    502: openApiJsonResponse(
      "Cloudflare request failed",
      PlatformErrorResponseSchema,
    ),
    503: openApiJsonResponse(
      "Deployments unavailable",
      PlatformErrorResponseSchema,
    ),
  },
});

function openApiJsonResponse(description: string, schema: z.ZodType) {
  return {
    description,
    content: {
      [JsonContentType]: { schema },
    },
  };
}

function typedRouteResponse(response: Response): never {
  return response as never;
}

function mountAuthApi(app: OpenAPIHono, env: BackendAppEnv, apiKey: string) {
  app.openapi(GetAuthClientConfigRoute, (c) =>
    typedRouteResponse(
      c.json(
        {
          auth: authClientConfig(env),
          api: {
            baseUrl: resolveBackendPublicUrl(env, c),
          },
          features: {
            cliAuth: Boolean(env.WORKOS_CLIENT_ID?.trim()),
            deployments: true,
          },
        },
        200,
      ),
    ),
  );

  app.openapi(GetCurrentIdentityRoute, async (c) => {
    try {
      const auth = await authenticateRequest(c, env, apiKey);
      if (!auth) {
        throw new PlatformApiError(
          401,
          "unauthorized",
          "Authentication is required.",
        );
      }
      if (auth.kind === "admin") {
        return typedRouteResponse(
          c.json(
            {
              auth: { kind: "admin" },
            },
            200,
          ),
        );
      }
      return typedRouteResponse(
        c.json(
          {
            auth: { kind: "workos" },
            organization: {
              id: auth.tenantId,
            },
            permissions: auth.permissions,
            role: auth.role ?? null,
            user: {
              id: auth.userId,
            },
          },
          200,
        ),
      );
    } catch (e) {
      return typedRouteResponse(apiErrorResponse(c, e));
    }
  });
}

function mountDeploymentApi(
  app: OpenAPIHono,
  env: BackendAppEnv,
  apiKey: string,
  deploymentDb?: WorkflowDeploymentRegistryDb,
) {
  app.openapi(ListTenantDeploymentsRoute, async (c) => {
    try {
      const tenantId = await resolveTenantAccess(
        c,
        env,
        apiKey,
        c.req.valid("param").tenantId,
      );
      const registry = requireWorkflowDeploymentRegistry(deploymentDb);
      return typedRouteResponse(
        c.json(
          {
            ok: true,
            tenantId,
            deployments: await registry.list(tenantId),
          },
          200,
        ),
      );
    } catch (e) {
      return typedRouteResponse(apiErrorResponse(c, e));
    }
  });

  app.openapi(GetTenantWorkflowsRoute, async (c) => {
    try {
      const tenantId = await resolveTenantAccess(
        c,
        env,
        apiKey,
        c.req.valid("param").tenantId,
      );
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
      return typedRouteResponse(
        c.json(
          {
            defaultWorkflow: Object.keys(workflows)[0],
            tenantId,
            workflows,
          },
          200,
        ),
      );
    } catch (e) {
      return typedRouteResponse(apiErrorResponse(c, e));
    }
  });

  app.openapi(ListDeploymentsRoute, async (c) => {
    try {
      const auth = await requireDeploymentAuth(c, env, apiKey);
      const config = resolveCloudflarePlatformConfig(env);
      const query = c.req.valid("query");
      const tagFilter =
        auth.kind === "workos"
          ? tagForTenant(resolveAuthorizedTenant(c, auth, query.tenantId))
          : parseDeploymentTagFilter(c);
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
      return typedRouteResponse(
        c.json(
          {
            ok: true,
            namespace: config.dispatchNamespace,
            deployments: response.result ?? [],
            resultInfo: response.result_info,
          },
          200,
        ),
      );
    } catch (e) {
      return typedRouteResponse(apiErrorResponse(c, e));
    }
  });

  app.openapi(CreateDeploymentRoute, async (c) => {
    try {
      const auth = await requireDeploymentAuth(c, env, apiKey);
      const config = resolveCloudflarePlatformConfig(env);
      const body = c.req.valid("json");
      const input = parseProvisionDeploymentInput(
        body,
        config,
        auth.kind === "workos" ? auth.tenantId : undefined,
      );
      if (auth.kind === "workos") {
        resolveAuthorizedTenant(c, auth, input.tenantId);
      }
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

      return typedRouteResponse(
        c.json(
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
        ),
      );
    } catch (e) {
      return typedRouteResponse(apiErrorResponse(c, e));
    }
  });

  app.openapi(DeleteDeploymentsRoute, async (c) => {
    try {
      const auth = await requireDeploymentAuth(c, env, apiKey);
      const config = resolveCloudflarePlatformConfig(env);
      const query = c.req.valid("query");
      const tagFilter =
        auth.kind === "workos"
          ? tagForTenant(resolveAuthorizedTenant(c, auth, query.tenantId))
          : parseDeploymentTagFilter(c);
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
        const tenantId =
          auth.kind === "workos" ? auth.tenantId : query.tenantId;
        if (tenantId) {
          await registry.deleteByTenant(parseTenantIdParam(tenantId));
        } else {
          await registry.deleteByTag(tagFilter);
        }
      }

      return typedRouteResponse(
        c.json(
          {
            ok: true,
            namespace: config.dispatchNamespace,
            tag: tagFilter,
            result: response.result ?? null,
          },
          200,
        ),
      );
    } catch (e) {
      return typedRouteResponse(apiErrorResponse(c, e));
    }
  });

  app.openapi(GetDeploymentRoute, async (c) => {
    try {
      const auth = await requireDeploymentAuth(c, env, apiKey);
      const config = resolveCloudflarePlatformConfig(env);
      const deploymentId = parseDeploymentIdParam(
        c.req.valid("param").deploymentId,
      );
      if (auth.kind === "workos") {
        await requireDeploymentAccess(deploymentDb, deploymentId, auth);
      }
      const response = await cloudflareApiRequest<unknown>(
        config,
        `/accounts/${encodeURIComponent(
          config.accountId,
        )}/workers/dispatch/namespaces/${encodeURIComponent(
          config.dispatchNamespace,
        )}/scripts/${encodeURIComponent(deploymentId)}`,
      );
      return typedRouteResponse(
        c.json(
          {
            ok: true,
            namespace: config.dispatchNamespace,
            deploymentId,
            deployment: response.result ?? null,
          },
          200,
        ),
      );
    } catch (e) {
      return typedRouteResponse(apiErrorResponse(c, e));
    }
  });

  app.openapi(DeleteDeploymentRoute, async (c) => {
    try {
      const auth = await requireDeploymentAuth(c, env, apiKey);
      const config = resolveCloudflarePlatformConfig(env);
      const deploymentId = parseDeploymentIdParam(
        c.req.valid("param").deploymentId,
      );
      if (auth.kind === "workos") {
        await requireDeploymentAccess(deploymentDb, deploymentId, auth);
      }
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
      return typedRouteResponse(
        c.json(
          {
            ok: true,
            namespace: config.dispatchNamespace,
            deploymentId,
            result: response.result ?? null,
          },
          200,
        ),
      );
    } catch (e) {
      return typedRouteResponse(apiErrorResponse(c, e));
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
  defaultTenantId?: string,
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
    async get(
      deploymentId: string,
    ): Promise<WorkflowDeploymentRecord | undefined> {
      const result = await db
        .prepare(
          `select tenant_id, deployment_id, label, workflow_api_url, dispatch_namespace, tags_json, created_at, updated_at
           from workflow_deployments
           where deployment_id = ?`,
        )
        .bind(deploymentId)
        .first<WorkflowDeploymentRow>();
      return result ? workflowDeploymentFromRow(result) : undefined;
    },

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

async function resolveTenantAccess(
  c: Context,
  env: BackendAppEnv,
  apiKey: string,
  requestedTenantId: string | undefined,
): Promise<string> {
  const isCurrentTenantAlias = requestedTenantId?.trim() === "me";
  const tenantId = isCurrentTenantAlias
    ? undefined
    : parseTenantIdParam(requestedTenantId);
  const auth = await authenticateRequest(c, env, apiKey);
  if (!auth) {
    if (isWorkOSConfigured(env)) {
      throw new PlatformApiError(
        401,
        "unauthorized",
        "Authentication is required.",
      );
    }
    if (!tenantId) {
      throw new PlatformApiError(
        401,
        "unauthorized",
        "Authentication is required.",
      );
    }
    return tenantId;
  }
  if (auth.kind === "admin") {
    if (tenantId) return tenantId;
    throw new PlatformApiError(
      400,
      "missing_tenant_id",
      'The "me" tenant alias requires WorkOS user authentication.',
    );
  }
  return resolveAuthorizedTenant(c, auth, tenantId);
}

async function requireDeploymentAuth(
  c: Context,
  env: BackendAppEnv,
  apiKey: string,
): Promise<AuthContext> {
  const auth = await authenticateRequest(c, env, apiKey);
  if (!auth) {
    throw new PlatformApiError(
      401,
      "unauthorized",
      "Authentication is required.",
    );
  }
  if (auth.kind === "workos" && c.req.query("tag")) {
    throw new PlatformApiError(
      403,
      "forbidden",
      "Tag filters require admin authentication.",
    );
  }
  return auth;
}

async function authenticateRequest(
  c: Context,
  env: BackendAppEnv,
  apiKey: string,
): Promise<AuthContext | undefined> {
  const token = bearerToken(c);
  if (!token) return undefined;
  if (token === apiKey) return { kind: "admin" };
  return authenticateWorkOSToken(env, token);
}

function bearerToken(c: Context): string | undefined {
  const header = c.req.header("Authorization");
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

function resolveAuthorizedTenant(
  _c: Context,
  auth: Extract<AuthContext, { kind: "workos" }>,
  requestedTenantId: string | undefined,
): string {
  const tenantId = requestedTenantId?.trim() || auth.tenantId;
  if (tenantId !== auth.tenantId) {
    throw new PlatformApiError(
      403,
      "forbidden",
      "Authenticated users can only access their selected WorkOS organization.",
    );
  }
  return tenantId;
}

async function requireDeploymentAccess(
  db: WorkflowDeploymentRegistryDb | undefined,
  deploymentId: string,
  auth: Extract<AuthContext, { kind: "workos" }>,
): Promise<void> {
  const registry = requireWorkflowDeploymentRegistry(db);
  const deployment = await registry.get(deploymentId);
  if (!deployment) {
    throw new PlatformApiError(
      403,
      "forbidden",
      "Deployment is not registered for the authenticated tenant.",
    );
  }
  if (deployment.tenantId !== auth.tenantId) {
    throw new PlatformApiError(
      403,
      "forbidden",
      "Authenticated users can only access their selected WorkOS organization.",
    );
  }
}

const workOSJwksCache = new Map<
  string,
  ReturnType<typeof createRemoteJWKSet>
>();

type WorkOSAuthConfig = {
  issuer?: string | string[];
  jwksUrl: string;
};

async function authenticateWorkOSToken(
  env: BackendAppEnv,
  token: string,
): Promise<AuthContext> {
  const config = resolveWorkOSAuthConfig(env);
  if (!config) {
    throw new PlatformApiError(
      401,
      "unauthorized",
      "WorkOS authentication is not configured.",
    );
  }

  let payload: WorkOSAccessTokenClaims;
  try {
    const verified = await jwtVerify(token, workOSJwks(config.jwksUrl), {
      ...(config.issuer ? { issuer: config.issuer } : {}),
    });
    payload = verified.payload as WorkOSAccessTokenClaims;
  } catch {
    throw new PlatformApiError(
      401,
      "unauthorized",
      "Invalid WorkOS access token.",
    );
  }

  const userId = payload.sub;
  const tenantId = payload.org_id;
  if (!userId) {
    throw new PlatformApiError(
      401,
      "unauthorized",
      "WorkOS access token is missing a subject.",
    );
  }
  if (!tenantId) {
    throw new PlatformApiError(
      403,
      "missing_organization",
      "Select a WorkOS organization before using tenant deployment APIs.",
    );
  }

  return {
    kind: "workos",
    userId,
    tenantId,
    ...(typeof payload.role === "string" ? { role: payload.role } : {}),
    permissions: Array.isArray(payload.permissions)
      ? payload.permissions.filter(
          (permission): permission is string => typeof permission === "string",
        )
      : [],
  };
}

function resolveWorkOSAuthConfig(
  env: BackendAppEnv,
): WorkOSAuthConfig | undefined {
  const clientId = env.WORKOS_CLIENT_ID?.trim();
  if (!clientId) return undefined;
  const apiOrigin = workOSApiOrigin(env.WORKOS_API_HOSTNAME);
  const issuer =
    env.WORKOS_ISSUER?.trim() ||
    `${apiOrigin}/user_management/${encodeURIComponent(clientId)}`;
  return {
    issuer: workOSIssuerCandidates(issuer),
    jwksUrl:
      env.WORKOS_JWKS_URL?.trim() ||
      `${apiOrigin}/sso/jwks/${encodeURIComponent(clientId)}`,
  };
}

function isWorkOSConfigured(env: BackendAppEnv): boolean {
  return Boolean(env.WORKOS_CLIENT_ID?.trim());
}

function workOSJwks(jwksUrl: string): ReturnType<typeof createRemoteJWKSet> {
  const cached = workOSJwksCache.get(jwksUrl);
  if (cached) return cached;
  const jwks = createRemoteJWKSet(new URL(jwksUrl));
  workOSJwksCache.set(jwksUrl, jwks);
  return jwks;
}

function authClientConfig(env: BackendAppEnv): {
  provider: "workos";
  clientId: string;
  apiHostname: string;
} | null {
  const clientId = env.WORKOS_CLIENT_ID?.trim();
  if (!clientId) return null;
  return {
    provider: "workos",
    clientId,
    apiHostname: workOSApiHostname(env.WORKOS_API_HOSTNAME),
  };
}

function workOSApiOrigin(hostname: string | undefined): string {
  const value = hostname?.trim() || "api.workos.com";
  if (/^https?:\/\//i.test(value)) return value.replace(/\/+$/, "");
  return `https://${value.replace(/^\/+|\/+$/g, "")}`;
}

function workOSApiHostname(hostname: string | undefined): string {
  return new URL(workOSApiOrigin(hostname)).hostname;
}

function workOSIssuerCandidates(issuer: string): string[] {
  const withoutSlash = issuer.replace(/\/+$/, "");
  return [withoutSlash, `${withoutSlash}/`];
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

function resolveBackendPublicUrl(env: BackendAppEnv, c: Context): string {
  return env.HYLO_BACKEND_PUBLIC_URL?.trim() || new URL(c.req.url).origin;
}

export type AppType = ReturnType<typeof createApp>;
