import { OpenAPIHono } from "@hono/zod-openapi";
import { notionProvider } from "@workflow/integrations-notion";
import { slackProvider } from "@workflow/integrations-slack";
import { spotifyProvider } from "@workflow/integrations-spotify";
import type { BrokerProviderRegistration } from "@workflow/oauth-broker";
import { createOAuthBrokerServer } from "@workflow/oauth-broker";
import {
  createPostgresBrokerStore,
  createPostgresWorkflowQueue,
  createPostgresWorkflowStateStore,
  type WorkflowPostgresDb,
} from "@workflow/postgres";
import {
  createRemoteRuntimeOpenApiDocument,
  createRemoteRuntimeServer,
  mountRemoteRuntimeOpenApi,
  type RemoteRuntimeOpenApiOptions,
} from "@workflow/remote";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { mountAuthApi, registerAuthOpenApiRoutes } from "./auth/routes";
import type { DeploymentBackend } from "./deployments/backend";
import { createDefaultCloudflareDeploymentBackend } from "./deployments/cloudflare-backend";
import type { WorkflowDeploymentRegistry } from "./deployments/registry";
import {
  mountDeploymentApi,
  registerDeploymentOpenApiRoutes,
} from "./deployments/routes";
import { parseDeploymentIdParam } from "./deployments/validators";
import { apiErrorResponse } from "./errors";
import { resolveBrokerBaseUrl } from "./public-url";
import type { BackendAppEnv } from "./types";

export type { BackendAppEnv } from "./types";

export type BackendAppOptions = {
  db: WorkflowPostgresDb;
  env?: BackendAppEnv;
  deploymentRegistry?: WorkflowDeploymentRegistry;
  deploymentBackend?: DeploymentBackend;
};

export function createBackendApp(options: BackendAppOptions) {
  const env = options.env ?? {};
  const deploymentBackend =
    options.deploymentBackend ?? createDefaultCloudflareDeploymentBackend(env);
  return createApp(
    options.db,
    env,
    options.deploymentRegistry,
    deploymentBackend,
  );
}

export function createApp(
  db: WorkflowPostgresDb,
  env: BackendAppEnv = {},
  deploymentRegistry?: WorkflowDeploymentRegistry,
  deploymentBackend: DeploymentBackend = createDefaultCloudflareDeploymentBackend(
    env,
  ),
) {
  const adapterOptions = { autoMigrate: false };
  const stateStore = createPostgresWorkflowStateStore(db, adapterOptions);
  const queue = createPostgresWorkflowQueue(db, adapterOptions);
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
  mountWorkerDispatchApi(app, deploymentBackend);
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
  mountAuthApi(app, env, apiKey, deploymentBackend);
  app.route(
    "/oauth",
    createOAuthBrokerServer({
      brokerBaseUrl: resolveBrokerBaseUrl(env),
      store: createPostgresBrokerStore(db, adapterOptions),
      authenticateAppToken: (token) =>
        token === apiKey ? { appId: "shared" } : undefined,
      providers: curatedProviders,
    }),
  );

  mountDeploymentApi(app, env, apiKey, deploymentRegistry, deploymentBackend);

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
  registerAuthOpenApiRoutes(app);
  registerDeploymentOpenApiRoutes(app);
}

function mountWorkerDispatchApi(
  app: OpenAPIHono,
  deploymentBackend: DeploymentBackend,
): void {
  const dispatch = async (c: Context) => {
    try {
      const deploymentId = parseDeploymentIdParam(c.req.param("deploymentId"));
      return mutableResponse(
        await deploymentBackend.fetchWorkflow(deploymentId, c.req.raw),
      );
    } catch (e) {
      return apiErrorResponse(c, e);
    }
  };

  app.all("/workers/:deploymentId", dispatch);
  app.all("/workers/:deploymentId/*", dispatch);
}

function mutableResponse(response: Response): Response {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function collectCuratedProviders(
  env: BackendAppEnv,
): BrokerProviderRegistration[] {
  const registrations: BrokerProviderRegistration[] = [];
  const catalog = [
    { spec: spotifyProvider, envPrefix: "SPOTIFY" },
    { spec: notionProvider, envPrefix: "NOTION" },
    { spec: slackProvider, envPrefix: "SLACK" },
  ];
  for (const { spec, envPrefix } of catalog) {
    const rawClientId = env[`${envPrefix}_CLIENT_ID` as keyof BackendAppEnv];
    const rawClientSecret =
      env[`${envPrefix}_CLIENT_SECRET` as keyof BackendAppEnv];
    const clientId = typeof rawClientId === "string" ? rawClientId : undefined;
    const clientSecret =
      typeof rawClientSecret === "string" ? rawClientSecret : undefined;
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

export type AppType = ReturnType<typeof createApp>;
