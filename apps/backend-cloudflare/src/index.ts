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
            // Workers cannot self-fetch their own custom domain (CF returns
            // error 1042). Route the tick through the dispatch namespace
            // binding so it lands on the tenant script directly. When
            // DISPATCHER isn't configured (local dev / Node), fall back to
            // plain HTTP — that path works because there's no self-fetch.
            fetch: env.DISPATCHER
              ? async (target, request) => {
                  // Workflow server is mounted at /api/workflow on the tenant
                  // script. The public URL embeds /workers/<id>/ for routing
                  // through the backend's HTTP proxy — strip that prefix
                  // before sending to the dispatch stub.
                  const incoming = new URL(request.url);
                  const prefix = `/workers/${target.deploymentId}`;
                  if (incoming.pathname.startsWith(prefix)) {
                    incoming.pathname = incoming.pathname.slice(prefix.length);
                  }
                  const dispatched = new Request(incoming.toString(), request);
                  const stub = env.DISPATCHER?.get(target.deploymentId);
                  if (!stub) return new Response("", { status: 503 });
                  return stub.fetch(dispatched);
                }
              : undefined,
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
