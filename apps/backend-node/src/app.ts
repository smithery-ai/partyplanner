import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { notionProvider } from "@workflow/integrations-notion";
import { spotifyProvider } from "@workflow/integrations-spotify";
import {
  type BrokerProviderRegistration,
  createInMemoryBrokerStore,
  createOAuthBrokerServer,
} from "@workflow/oauth-broker";
import {
  createPostgresWorkflowQueue,
  createPostgresWorkflowStateStore,
} from "@workflow/postgres";
import {
  createRemoteRuntimeServer,
  mountRemoteRuntimeOpenApi,
} from "@workflow/remote";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import { cors } from "hono/cors";

export type BackendNodeAppOptions = {
  dataDir?: string;
};

export function createApp(options: BackendNodeAppOptions = {}) {
  const dataDir =
    options.dataDir ??
    process.env.HYLO_BACKEND_NODE_DATA_DIR ??
    "./.hylo-backend-node";
  mkdirSync(dirname(dataDir), { recursive: true });
  const client = new PGlite(dataDir);
  const db = drizzle({ client });

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
    title: "Hylo Backend Node API",
    runtimeBasePath: "/runtime",
  });
  app.route(
    "/runtime",
    createRemoteRuntimeServer({
      basePath: "/",
      stateStore: createPostgresWorkflowStateStore(db),
      queue: createPostgresWorkflowQueue(db),
      cors: false,
    }),
  );

  const curatedProviders = collectCuratedProviders();
  const apiKey = resolveApiKey();
  const brokerBaseUrl = resolveBrokerBaseUrl();
  app.route(
    "/oauth",
    createOAuthBrokerServer({
      brokerBaseUrl,
      store: createInMemoryBrokerStore(),
      authenticateAppToken: (token) =>
        token === apiKey ? { appId: "shared" } : undefined,
      providers: curatedProviders,
    }),
  );

  return app;
}

// Hylo's curated OAuth provider catalog. The set of providers is fixed at
// build time; users cannot add their own providers through the backend
// (workers are isolated from backend code). Workers that need a provider
// Hylo doesn't curate use `createCustomConnection` and bring their own
// client credentials instead.
//
// A provider is registered only when both env vars are present, so a
// missing credential pair leaves that provider unavailable; the broker's
// /start route returns a structured 404 for unregistered providers.
function collectCuratedProviders(): BrokerProviderRegistration[] {
  const registrations: BrokerProviderRegistration[] = [];
  const catalog = [
    { spec: spotifyProvider, envPrefix: "SPOTIFY" },
    { spec: notionProvider, envPrefix: "NOTION" },
  ];
  for (const { spec, envPrefix } of catalog) {
    const clientId = process.env[`${envPrefix}_CLIENT_ID`];
    const clientSecret = process.env[`${envPrefix}_CLIENT_SECRET`];
    if (clientId && clientSecret) {
      registrations.push({ spec, clientId, clientSecret });
    }
  }
  return registrations;
}

// Stable dev default — matches the worker-side default in
// @workflow/integrations-oauth so local setups work without coordinating env
// vars between backend-node and the Next.js worker.
const DEV_API_KEY = "local-dev-hylo-api-key";

function resolveApiKey(): string {
  const explicit = process.env.HYLO_API_KEY?.trim();
  if (explicit) return explicit;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "HYLO_API_KEY is required to mount the OAuth broker in production. Set it in the backend-node environment.",
    );
  }
  console.warn(
    `[oauth-broker] HYLO_API_KEY is not set; using dev default "${DEV_API_KEY}". Set HYLO_API_KEY in both backend-node and worker env to override.`,
  );
  return DEV_API_KEY;
}

function resolveBrokerBaseUrl(): string {
  const explicit = process.env.HYLO_BROKER_BASE_URL?.trim();
  if (explicit) return explicit;
  const backendUrl = process.env.HYLO_BACKEND_PUBLIC_URL?.trim();
  if (backendUrl) return `${backendUrl.replace(/\/+$/, "")}/oauth`;
  // Local dev default. In production this must be set to a URL that matches
  // each provider's whitelisted redirect_uri.
  return `http://localhost:${process.env.PORT ?? 8787}/oauth`;
}
