import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  type AuthContext,
  authClientConfig,
  authenticateRequest,
  authenticateWorkOSUserRequest,
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

const CurrentUserOrganizationSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    membershipId: z.string(),
    role: z.string().nullable().optional(),
    roles: z.array(z.string()).optional(),
    status: z.enum(["active", "inactive", "pending"]),
  })
  .openapi("CurrentUserOrganization");

const CurrentUserOrganizationsSchema = z
  .object({
    organizations: z.array(CurrentUserOrganizationSchema),
  })
  .openapi("CurrentUserOrganizations");

const WorkOSMembershipSchema = z
  .object({
    id: z.string(),
    organization_id: z.string().optional(),
    organizationId: z.string().optional(),
    organization_name: z.string().optional(),
    organizationName: z.string().optional(),
    role: z
      .union([z.object({ slug: z.string().optional() }), z.string()])
      .nullable()
      .optional(),
    roles: z
      .array(z.union([z.object({ slug: z.string().optional() }), z.string()]))
      .optional(),
    status: z.enum(["active", "inactive", "pending"]).optional(),
  })
  .passthrough();

const WorkOSMembershipListSchema = z
  .object({
    data: z.array(WorkOSMembershipSchema),
  })
  .passthrough();

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

const GetCurrentUserOrganizationsRoute = createRoute({
  method: "get",
  path: "/me/organizations",
  operationId: "getCurrentUserOrganizations",
  tags: ["Auth"],
  summary: "List WorkOS organizations for the authenticated user",
  security: BearerSecurity,
  responses: {
    200: openApiJsonResponse(
      "Authenticated user's WorkOS organizations",
      CurrentUserOrganizationsSchema,
    ),
    401: openApiJsonResponse(
      "Authentication failed",
      z.object({ error: z.string(), message: z.string() }),
    ),
    503: openApiJsonResponse(
      "WorkOS management API is not configured",
      z.object({ error: z.string(), message: z.string() }),
    ),
  },
});

export function registerAuthOpenApiRoutes(app: OpenAPIHono): void {
  app.openAPIRegistry.registerPath(GetAuthClientConfigRoute);
  app.openAPIRegistry.registerPath(GetCurrentIdentityRoute);
  app.openAPIRegistry.registerPath(GetCurrentUserOrganizationsRoute);
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

  app.openapi(GetCurrentUserOrganizationsRoute, async (c) => {
    try {
      const auth = await authenticateWorkOSUserRequest(c, env, apiKey);
      if (!auth) {
        throw new PlatformApiError(
          401,
          "unauthorized",
          "WorkOS user authentication is required.",
        );
      }
      return typedRouteResponse(
        c.json(
          {
            organizations: await listWorkOSUserOrganizations(env, auth.userId),
          },
          200,
        ),
      );
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

async function listWorkOSUserOrganizations(
  env: BackendAppEnv,
  userId: string,
): Promise<z.infer<typeof CurrentUserOrganizationSchema>[]> {
  const apiKey = env.WORKOS_API_KEY?.trim();
  if (!apiKey) {
    throw new PlatformApiError(
      503,
      "workos_api_key_missing",
      "WORKOS_API_KEY is required to list WorkOS organization memberships.",
    );
  }

  const url = new URL(
    "/user_management/organization_memberships",
    workOSApiOrigin(env.WORKOS_API_HOSTNAME),
  );
  url.searchParams.set("user_id", userId);
  url.searchParams.set("limit", "100");

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });
  if (!response.ok) {
    throw new PlatformApiError(
      502,
      "workos_request_failed",
      `WorkOS organization memberships request failed with HTTP ${response.status}.`,
    );
  }

  const body = WorkOSMembershipListSchema.parse(await response.json());
  return body.data.map((membership) => {
    const organizationId =
      membership.organization_id ?? membership.organizationId;
    const organizationName =
      membership.organization_name ?? membership.organizationName;
    if (!organizationId || !organizationName) {
      throw new PlatformApiError(
        502,
        "workos_response_invalid",
        "WorkOS organization membership response is missing organization details.",
      );
    }
    return {
      id: organizationId,
      name: organizationName,
      membershipId: membership.id,
      role: roleSlug(membership.role) ?? null,
      roles:
        membership.roles
          ?.map((role) => roleSlug(role))
          .filter((slug): slug is string => Boolean(slug)) ?? [],
      status: membership.status ?? "active",
    };
  });
}

function roleSlug(
  role: { slug?: string } | string | null | undefined,
): string | undefined {
  return typeof role === "string" ? role : role?.slug;
}

function workOSApiOrigin(hostname: string | undefined): string {
  const value = hostname?.trim() || "api.workos.com";
  if (/^https?:\/\//i.test(value)) return value.replace(/\/+$/, "");
  return `https://${value.replace(/^\/+|\/+$/g, "")}`;
}
