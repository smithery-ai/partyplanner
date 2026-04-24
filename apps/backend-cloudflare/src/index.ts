import {
  type BackendAppEnv,
  createBackendApp,
  createWorkflowDeploymentRegistry,
} from "@hylo/backend";
import { createDefaultCloudflareDeploymentBackend } from "@hylo/backend/cloudflare";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

export default {
  fetch(request, env) {
    const client = postgres(resolvePostgresConnectionString(env), {
      max: 5,
      fetch_types: false,
      prepare: true,
    });
    const db = drizzle(client);
    const deploymentRegistry = createWorkflowDeploymentRegistry(db);
    return createBackendApp({
      db,
      env,
      deploymentRegistry,
      deploymentBackend: createDefaultCloudflareDeploymentBackend(env),
    }).fetch(request);
  },
} satisfies ExportedHandler<Env>;

export type Env = BackendAppEnv;

function resolvePostgresConnectionString(env: BackendAppEnv): string {
  const connectionString =
    env.HYPERDRIVE?.connectionString ?? env.POSTGRES_URL ?? env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "Configure a HYPERDRIVE binding, POSTGRES_URL, or DATABASE_URL for backend storage.",
    );
  }
  return connectionString;
}
