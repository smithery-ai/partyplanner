import {
  type BackendAppEnv,
  createBackendApp,
  createWorkflowDeploymentRegistry,
  deploymentSourceFromList,
  dispatchTickToDeployments,
} from "@hylo/backend";
import { createDefaultCloudflareDeploymentBackend } from "@hylo/backend/cloudflare";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

function withDb<T>(
  env: BackendAppEnv,
  fn: (
    db: ReturnType<typeof drizzle>,
    deploymentRegistry: ReturnType<typeof createWorkflowDeploymentRegistry>,
  ) => T,
): T {
  const client = postgres(resolvePostgresConnectionString(env), {
    max: 5,
    fetch_types: false,
    prepare: true,
  });
  const db = drizzle(client);
  return fn(db, createWorkflowDeploymentRegistry(db));
}

export default {
  fetch(request, env) {
    return withDb(env, (db, deploymentRegistry) =>
      createBackendApp({
        db,
        env,
        deploymentRegistry,
        deploymentBackend: createDefaultCloudflareDeploymentBackend(
          env,
          deploymentRegistry,
        ),
      }).fetch(request),
    );
  },
  // Cloudflare cron triggers fire here. We translate the platform-native event
  // into the workflow-model tick by fanning `POST /schedules/tick` out to every
  // registered deployment via the shared dispatcher in @hylo/backend.
  scheduled(event, env, ctx) {
    ctx.waitUntil(
      withDb(env, async (_db, deploymentRegistry) => {
        const source = deploymentSourceFromList(
          () => deploymentRegistry.listAll(),
          { apiKey: env.HYLO_API_KEY },
        );
        await dispatchTickToDeployments(
          {
            source,
            onError: (error, target) => {
              console.error(
                JSON.stringify({
                  scope: "schedule_dispatch",
                  level: "error",
                  deploymentId: target.deploymentId,
                  error: error instanceof Error ? error.message : String(error),
                }),
              );
            },
          },
          new Date(event.scheduledTime),
        );
      }),
    );
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
