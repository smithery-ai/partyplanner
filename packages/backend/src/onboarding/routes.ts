import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  deletePostgresTenantData,
  type WorkflowPostgresDb,
} from "@workflow/postgres";
import type { Context } from "hono";
import {
  type AuthContext,
  authenticateRequest,
  resolveAuthorizedTenant,
} from "../auth/workos";
import { parseTenantIdParam } from "../deployments/validators";
import { apiErrorResponse, PlatformApiError } from "../errors";
import {
  BearerSecurity,
  openApiJsonResponse,
  PlatformErrorResponseSchema,
  typedRouteResponse,
} from "../openapi";
import type { BackendAppEnv } from "../types";

const TenantParamSchema = z.object({
  tenantId: z.string().openapi({ param: { name: "tenantId", in: "path" } }),
});

const OnboardingResetResponseSchema = z
  .object({
    ok: z.literal(true),
    tenantId: z.string(),
    deleted: z.object({
      workflowDeployments: z.number(),
      workflowRunDocuments: z.number(),
      workflowRunStates: z.number(),
      workflowEvents: z.number(),
      workflowQueueItems: z.number(),
      oauthPending: z.number(),
      oauthHandoffs: z.number(),
      oauthRefreshTokens: z.number(),
      providerInstallations: z.number(),
    }),
  })
  .openapi("OnboardingResetResponse");

const ResetOnboardingRoute = createRoute({
  method: "delete",
  path: "/tenants/{tenantId}/onboarding",
  operationId: "resetTenantOnboarding",
  tags: ["Tenants"],
  summary: "Delete tenant database data and return to onboarding",
  security: BearerSecurity,
  request: { params: TenantParamSchema },
  responses: {
    200: openApiJsonResponse(
      "Tenant data deleted",
      OnboardingResetResponseSchema,
    ),
    400: openApiJsonResponse("Invalid request", PlatformErrorResponseSchema),
    401: openApiJsonResponse(
      "Authentication failed",
      PlatformErrorResponseSchema,
    ),
    403: openApiJsonResponse("Forbidden", PlatformErrorResponseSchema),
  },
});

export function registerOnboardingOpenApiRoutes(app: OpenAPIHono): void {
  app.openAPIRegistry.registerPath(ResetOnboardingRoute);
}

export function mountOnboardingApi(
  app: OpenAPIHono,
  db: WorkflowPostgresDb,
  env: BackendAppEnv,
  apiKey: string,
) {
  app.openapi(ResetOnboardingRoute, async (c) => {
    try {
      const tenantId = await resolveResetTenant(
        c,
        env,
        apiKey,
        c.req.valid("param").tenantId,
      );
      const result = await deletePostgresTenantData(db, tenantId);
      return typedRouteResponse(c.json({ ok: true, ...result }, 200));
    } catch (e) {
      return typedRouteResponse(apiErrorResponse(c, e));
    }
  });
}

async function resolveResetTenant(
  c: Context,
  env: BackendAppEnv,
  apiKey: string,
  requestedTenantId: string | undefined,
): Promise<string> {
  const auth = await authenticateRequest(c, env, apiKey);
  if (!auth) {
    throw new PlatformApiError(
      401,
      "unauthorized",
      "Authentication is required.",
    );
  }
  return resolveTenantForAuth(c, auth, requestedTenantId);
}

function resolveTenantForAuth(
  c: Context,
  auth: AuthContext,
  requestedTenantId: string | undefined,
): string {
  const isCurrentTenantAlias = requestedTenantId?.trim() === "me";
  if (auth.kind === "admin") {
    if (isCurrentTenantAlias) {
      throw new PlatformApiError(
        400,
        "missing_tenant_id",
        'The "me" tenant alias requires WorkOS user authentication.',
      );
    }
    return parseTenantIdParam(requestedTenantId);
  }
  const tenantId = isCurrentTenantAlias
    ? undefined
    : parseTenantIdParam(requestedTenantId);
  return resolveAuthorizedTenant(c, auth, tenantId);
}
