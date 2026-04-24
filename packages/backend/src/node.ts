import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createBackendApp } from "./app";
import { createLocalDeploymentBackend } from "./deployments/local-backend";
import { createWorkflowDeploymentRegistry } from "./deployments/registry";
import type { BackendAppEnv } from "./types";

export function createNodeBackendApp(env: BackendAppEnv = process.env) {
  const normalizedEnv = normalizeNodeBackendEnv(env);
  const client = postgres(resolvePostgresConnectionString(normalizedEnv), {
    max: 5,
    fetch_types: false,
    prepare: true,
  });
  const db = drizzle(client);
  const deploymentRegistry = createWorkflowDeploymentRegistry(db);
  return createBackendApp({
    db,
    env: normalizedEnv,
    deploymentRegistry,
    deploymentBackend: createLocalDeploymentBackend(
      normalizedEnv,
      deploymentRegistry,
    ),
  });
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
