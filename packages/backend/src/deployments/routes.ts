import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  type AuthContext,
  authenticateRequest,
  isWorkOSConfigured,
  resolveAuthorizedTenant,
} from "../auth/workos";
import { apiErrorResponse, PlatformApiError } from "../errors";
import {
  BearerSecurity,
  JsonContentType,
  openApiJsonResponse,
  PlatformErrorResponseSchema,
  typedRouteResponse,
} from "../openapi";
import type { BackendAppEnv } from "../types";
import type { DeploymentBackend } from "./backend";
import { assertWorkerTags, tagForTenant } from "./ids";
import {
  requireWorkflowDeploymentRegistry,
  type WorkflowDeploymentRegistry,
} from "./registry";
import {
  parseDeploymentIdParam,
  parseProvisionDeploymentInput,
  parseTenantIdParam,
} from "./validators";

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
  tenantId: z.string().openapi({ param: { name: "tenantId", in: "path" } }),
});

const DeploymentParamSchema = z.object({
  deploymentId: z
    .string()
    .openapi({ param: { name: "deploymentId", in: "path" } }),
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
    workflowId: z.string().optional(),
    workflowName: z.string().optional(),
    workflowVersion: z.string().optional(),
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
    result: z.unknown().nullable(),
  })
  .openapi("CreateDeploymentResponse");

const DeleteDeploymentsResponseSchema = z
  .object({
    ok: z.literal(true),
    namespace: z.string(),
    tag: z.string(),
    result: z.unknown().nullable(),
  })
  .openapi("DeleteDeploymentsResponse");

const GetDeploymentResponseSchema = z
  .object({
    ok: z.literal(true),
    namespace: z.string(),
    deploymentId: z.string(),
    deployment: z.unknown().nullable(),
  })
  .openapi("GetDeploymentResponse");

const DeleteDeploymentResponseSchema = z
  .object({
    ok: z.literal(true),
    namespace: z.string(),
    deploymentId: z.string(),
    result: z.unknown().nullable(),
  })
  .openapi("DeleteDeploymentResponse");

const DEPLOY_ERROR_RESPONSES = {
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
};

const ListTenantDeploymentsRoute = createRoute({
  method: "get",
  path: "/tenants/{tenantId}/deployments",
  operationId: "listTenantDeployments",
  tags: ["Tenants"],
  summary: "List registered deployments for a tenant",
  security: BearerSecurity,
  request: { params: TenantParamSchema },
  responses: {
    200: openApiJsonResponse(
      "Tenant deployments",
      TenantDeploymentsResponseSchema,
    ),
    ...DEPLOY_ERROR_RESPONSES,
  },
});

const GetTenantWorkflowsRoute = createRoute({
  method: "get",
  path: "/tenants/{tenantId}/workflows",
  operationId: "getTenantWorkflows",
  tags: ["Tenants"],
  summary: "Get workflow registry for a tenant",
  security: BearerSecurity,
  request: { params: TenantParamSchema },
  responses: {
    200: openApiJsonResponse(
      "Tenant workflow registry",
      TenantWorkflowRegistrySchema,
    ),
    ...DEPLOY_ERROR_RESPONSES,
  },
});

const ListDeploymentsRoute = createRoute({
  method: "get",
  path: "/deployments",
  operationId: "listDeployments",
  tags: ["Deployments"],
  summary: "List Cloudflare tenant Workers",
  security: BearerSecurity,
  request: { query: DeploymentFilterQuerySchema },
  responses: {
    200: openApiJsonResponse(
      "Cloudflare deployments",
      ListDeploymentsResponseSchema,
    ),
    ...DEPLOY_ERROR_RESPONSES,
  },
});

const CreateDeploymentRoute = createRoute({
  method: "post",
  path: "/deployments",
  operationId: "createDeployment",
  tags: ["Deployments"],
  summary: "Provision a tenant Worker",
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
      "Deployment created",
      CreateDeploymentResponseSchema,
    ),
    ...DEPLOY_ERROR_RESPONSES,
  },
});

const DeleteDeploymentsRoute = createRoute({
  method: "delete",
  path: "/deployments",
  operationId: "deleteDeployments",
  tags: ["Deployments"],
  summary: "Delete Cloudflare tenant Workers by filter",
  security: BearerSecurity,
  request: { query: DeploymentFilterQuerySchema },
  responses: {
    200: openApiJsonResponse(
      "Deployments deleted",
      DeleteDeploymentsResponseSchema,
    ),
    ...DEPLOY_ERROR_RESPONSES,
  },
});

const GetDeploymentRoute = createRoute({
  method: "get",
  path: "/deployments/{deploymentId}",
  operationId: "getDeployment",
  tags: ["Deployments"],
  summary: "Get a Cloudflare tenant Worker",
  security: BearerSecurity,
  request: { params: DeploymentParamSchema },
  responses: {
    200: openApiJsonResponse("Deployment", GetDeploymentResponseSchema),
    ...DEPLOY_ERROR_RESPONSES,
  },
});

const DeleteDeploymentRoute = createRoute({
  method: "delete",
  path: "/deployments/{deploymentId}",
  operationId: "deleteDeployment",
  tags: ["Deployments"],
  summary: "Delete a Cloudflare tenant Worker",
  security: BearerSecurity,
  request: { params: DeploymentParamSchema },
  responses: {
    200: openApiJsonResponse(
      "Deployment deleted",
      DeleteDeploymentResponseSchema,
    ),
    ...DEPLOY_ERROR_RESPONSES,
  },
});

export function registerDeploymentOpenApiRoutes(app: OpenAPIHono): void {
  app.openAPIRegistry.registerPath(ListTenantDeploymentsRoute);
  app.openAPIRegistry.registerPath(GetTenantWorkflowsRoute);
  app.openAPIRegistry.registerPath(ListDeploymentsRoute);
  app.openAPIRegistry.registerPath(CreateDeploymentRoute);
  app.openAPIRegistry.registerPath(DeleteDeploymentsRoute);
  app.openAPIRegistry.registerPath(GetDeploymentRoute);
  app.openAPIRegistry.registerPath(DeleteDeploymentRoute);
}

export function mountDeploymentApi(
  app: OpenAPIHono,
  env: BackendAppEnv,
  apiKey: string,
  deploymentRegistry: WorkflowDeploymentRegistry | undefined,
  deploymentBackend: DeploymentBackend,
) {
  app.openapi(ListTenantDeploymentsRoute, async (c) => {
    try {
      const tenantId = await resolveTenantAccess(
        c,
        env,
        apiKey,
        c.req.valid("param").tenantId,
      );
      const registry = requireWorkflowDeploymentRegistry(deploymentRegistry);
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
      const registry = requireWorkflowDeploymentRegistry(deploymentRegistry);
      const deployments = await registry.list(tenantId);
      const workflows = Object.fromEntries(
        deployments.flatMap((deployment) =>
          deployment.workflowApiUrl
            ? [
                [
                  deployment.deploymentId,
                  {
                    ...(deployment.label ? { label: deployment.label } : {}),
                    url: deployment.workflowApiUrl,
                  },
                ],
              ]
            : [],
        ),
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
      const query = c.req.valid("query");
      const tagFilter =
        auth.kind === "workos"
          ? tagForTenant(resolveAuthorizedTenant(c, auth, query.tenantId))
          : parseDeploymentTagFilter(c);
      const response = await deploymentBackend.list(tagFilter);
      return typedRouteResponse(
        c.json(
          {
            ok: true,
            namespace: deploymentBackend.namespace,
            deployments: response.deployments,
            resultInfo: response.resultInfo,
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
      const requestUrl = new URL(c.req.url);
      const requestConfig = {
        ...deploymentBackend.config,
        workerDispatchBaseUrl:
          deploymentBackend.config.workerDispatchBaseUrl ??
          `${requestUrl.origin}/workers`,
      };
      const input = parseProvisionDeploymentInput(
        c.req.valid("json"),
        requestConfig,
        auth.kind === "workos" ? auth.tenantId : undefined,
        auth.kind === "admin",
      );
      if (auth.kind === "workos") {
        resolveAuthorizedTenant(c, auth, input.tenantId);
      }

      const registry = deploymentRegistry;
      const workflowApiUrl = deploymentBackend.resolveWorkflowApiUrl(input);
      if (registry) {
        await registry.upsert({
          tenantId: input.tenantId,
          deploymentId: input.deploymentId,
          label: input.label,
          workflowApiUrl,
          dispatchNamespace: deploymentBackend.namespace,
          tags: input.tags,
        });
      }

      let result: unknown;
      try {
        result = await deploymentBackend.create(input, requestUrl.origin);
      } catch (error) {
        if (registry) {
          await registry.delete(input.deploymentId);
        }
        throw error;
      }

      return typedRouteResponse(
        c.json(
          {
            ok: true,
            tenantId: input.tenantId,
            deploymentId: input.deploymentId,
            namespace: deploymentBackend.namespace,
            workflowApiUrl,
            tags: input.tags,
            result,
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

      const result = await deploymentBackend.deleteMany(tagFilter);
      if (deploymentRegistry) {
        const registry = deploymentRegistry;
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
            namespace: deploymentBackend.namespace,
            tag: tagFilter,
            result,
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
      const deploymentId = parseDeploymentIdParam(
        c.req.valid("param").deploymentId,
      );
      if (auth.kind === "workos") {
        await requireDeploymentAccess(deploymentRegistry, deploymentId, auth);
      }

      const deployment = await deploymentBackend.get(deploymentId);
      return typedRouteResponse(
        c.json(
          {
            ok: true,
            namespace: deploymentBackend.namespace,
            deploymentId,
            deployment,
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
      const deploymentId = parseDeploymentIdParam(
        c.req.valid("param").deploymentId,
      );
      if (auth.kind === "workos") {
        await requireDeploymentAccess(deploymentRegistry, deploymentId, auth);
      }

      const result = await deploymentBackend.delete(deploymentId);
      if (deploymentRegistry) {
        await deploymentRegistry.delete(deploymentId);
      }
      return typedRouteResponse(
        c.json(
          {
            ok: true,
            namespace: deploymentBackend.namespace,
            deploymentId,
            result,
          },
          200,
        ),
      );
    } catch (e) {
      return typedRouteResponse(apiErrorResponse(c, e));
    }
  });
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

async function requireDeploymentAccess(
  registry: WorkflowDeploymentRegistry | undefined,
  deploymentId: string,
  auth: Extract<AuthContext, { kind: "workos" }>,
): Promise<void> {
  const deployment =
    await requireWorkflowDeploymentRegistry(registry).get(deploymentId);
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
