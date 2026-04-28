import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createBackendApp } from "./app";
import { createLocalDeploymentBackend } from "./deployments/local-backend";
import {
  createWorkflowDeploymentRegistry,
  type WorkflowDeploymentRegistry,
} from "./deployments/registry";
import { deploymentSourceFromList } from "./scheduling/dispatcher";
import { createNodeScheduler, type NodeScheduler } from "./scheduling/node";
import type { BackendAppEnv } from "./types";

export type NodeBackendApp = {
  fetch: (request: Request) => Promise<Response>;
  scheduler: NodeScheduler;
  deploymentRegistry: WorkflowDeploymentRegistry;
  start(): void;
  stop(): void;
};

export function createNodeBackendApp(
  env: BackendAppEnv = process.env,
): NodeBackendApp {
  const normalizedEnv = normalizeNodeBackendEnv(env);
  const client = postgres(resolvePostgresConnectionString(normalizedEnv), {
    max: 20,
    fetch_types: false,
    prepare: true,
  });
  const db = drizzle(client);
  const deploymentRegistry = createWorkflowDeploymentRegistry(db);
  const app = createBackendApp({
    db,
    env: normalizedEnv,
    deploymentRegistry,
    deploymentBackend: createLocalDeploymentBackend(
      normalizedEnv,
      deploymentRegistry,
    ),
  });

  const scheduler = createNodeScheduler({
    intervalMs: parseInterval(normalizedEnv.HYLO_SCHEDULER_INTERVAL_MS),
    resolveSource: () =>
      deploymentSourceFromList(() => deploymentRegistry.listAll(), {
        apiKey: normalizedEnv.HYLO_API_KEY,
      }),
    onError: (error) =>
      console.error(
        JSON.stringify({
          scope: "schedule_dispatch",
          level: "error",
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
  });

  return {
    fetch: app.fetch as NodeBackendApp["fetch"],
    scheduler,
    deploymentRegistry,
    start() {
      if (normalizedEnv.HYLO_SCHEDULER_DISABLED === "true") return;
      scheduler.start();
    },
    stop() {
      scheduler.stop();
    },
  };
}

function normalizeNodeBackendEnv(env: BackendAppEnv): BackendAppEnv {
  return {
    ...env,
    WORKOS_API_HOSTNAME:
      env.WORKOS_API_HOSTNAME ?? env.VITE_WORKOS_API_HOSTNAME,
    WORKOS_CLIENT_ID: env.WORKOS_CLIENT_ID ?? env.VITE_WORKOS_CLIENT_ID,
  };
}

function resolvePostgresConnectionString(env: BackendAppEnv): string {
  const connectionString = env.POSTGRES_URL ?? env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "Configure POSTGRES_URL or DATABASE_URL for backend storage.",
    );
  }
  return connectionString;
}

function parseInterval(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1_000 ? n : undefined;
}
