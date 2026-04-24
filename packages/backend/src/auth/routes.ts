import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  type AuthContext,
  authClientConfig,
  authenticateRequest,
  isWorkOSConfigured,
} from "../auth/workos";
import type { DeploymentBackend } from "../deployments/backend";
import { apiErrorResponse, PlatformApiError } from "../errors";
import {
  BearerSecurity,
  openApiJsonResponse,
  typedRouteResponse,
} from "../openapi";
import type { BackendAppEnv } from "../types";

const AuthClientConfigSchema = z
  .object({
    auth: z
      .object({
        provider: z.literal("workos"),
        clientId: z.string(),
        apiHostname: z.string(),
        cliApiHostname: z.string().optional(),
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

const GetAuthClientConfigRoute = createRoute({
  method: "get",
  path: "/auth/client-config",
  operationId: "getAuthClientConfig",
  tags: ["Auth"],
  summary: "Get public auth client configuration",
  responses: {
    200: openApiJsonResponse(
      "Auth client configuration",
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
      z.object({ error: z.string(), message: z.string() }),
    ),
  },
});

export function registerAuthOpenApiRoutes(app: OpenAPIHono): void {
  app.openAPIRegistry.registerPath(GetAuthClientConfigRoute);
  app.openAPIRegistry.registerPath(GetCurrentIdentityRoute);
}

export function mountAuthApi(
  app: OpenAPIHono,
  env: BackendAppEnv,
  apiKey: string,
  deploymentBackend: DeploymentBackend,
) {
  app.openapi(GetAuthClientConfigRoute, (c) =>
    typedRouteResponse(
      c.json(
        {
          auth: authClientConfig(env),
          api: {
            baseUrl: resolveBackendPublicUrl(env, c),
          },
          features: {
            cliAuth: isWorkOSConfigured(env),
            deployments: deploymentBackend.configured,
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
      return typedRouteResponse(c.json(currentIdentity(auth), 200));
    } catch (e) {
      return typedRouteResponse(apiErrorResponse(c, e));
    }
  });
}

function currentIdentity(auth: AuthContext) {
  if (auth.kind === "admin") {
    return {
      auth: { kind: "admin" },
    };
  }
  return {
    auth: { kind: "workos" },
    organization: {
      id: auth.tenantId,
    },
    permissions: auth.permissions,
    role: auth.role ?? null,
    user: {
      id: auth.userId,
    },
  };
}

function resolveBackendPublicUrl(env: BackendAppEnv, c: Context): string {
  return env.HYLO_BACKEND_PUBLIC_URL?.trim() || new URL(c.req.url).origin;
}
