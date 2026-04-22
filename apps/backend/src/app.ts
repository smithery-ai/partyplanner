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
  type RemoteRuntimeIdentity,
} from "@workflow/remote";
import { Hono } from "hono";
import { cors } from "hono/cors";

export type BackendAppEnv = {
  HYLO_API_KEY?: string;
  HYLO_BACKEND_PUBLIC_URL?: string;
  HYLO_BROKER_BASE_URL?: string;
  NODE_ENV?: string;
  NOTION_CLIENT_ID?: string;
  NOTION_CLIENT_SECRET?: string;
  SPOTIFY_CLIENT_ID?: string;
  SPOTIFY_CLIENT_SECRET?: string;
};

type BackendApiKeyIdentity = RemoteRuntimeIdentity & {
  appId: string;
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
      allowMethods: ["GET", "PUT", "POST", "OPTIONS"],
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
      authenticateAppToken: (token) => authenticateApiKey(token, apiKey),
    }),
  );

  const curatedProviders = collectCuratedProviders(env);
  const apiKey = resolveApiKey(env);
  app.route(
    "/oauth",
    createOAuthBrokerServer({
      brokerBaseUrl: resolveBrokerBaseUrl(env),
      store: createCloudflareBrokerStore(db, adapterOptions),
      authenticateAppToken: (token) => authenticateApiKey(token, apiKey),
      providers: curatedProviders,
    }),
  );

  return app;
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

function authenticateApiKey(
  token: string,
  apiKey: string,
): BackendApiKeyIdentity | undefined {
  if (token !== apiKey) return undefined;
  return identityForApiKey(apiKey);
}

function identityForApiKey(apiKey: string): BackendApiKeyIdentity {
  const id = stableId(apiKey);
  return {
    appId: `app_${id}`,
    organizationId: `org_${id}`,
    userId: `user_${id}`,
  };
}

function stableId(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function resolveBrokerBaseUrl(env: BackendAppEnv): string {
  const explicit = env.HYLO_BROKER_BASE_URL?.trim();
  if (explicit) return explicit;
  const backendUrl = env.HYLO_BACKEND_PUBLIC_URL?.trim();
  if (backendUrl) return `${backendUrl.replace(/\/+$/, "")}/oauth`;
  return "https://api-worker.hylo.localhost/oauth";
}

export type AppType = ReturnType<typeof createApp>;
