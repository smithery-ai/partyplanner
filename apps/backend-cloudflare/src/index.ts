import {
  type BackendAppEnv,
  createBackendApp,
  createWorkflowDeploymentRegistry,
} from "@hylo/backend";
import { createDefaultCloudflareDeploymentBackend } from "@hylo/backend/cloudflare";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

type AdvanceMessage = {
  runId: string;
  deploymentId: string;
};

type WorkerEnv = BackendAppEnv & {
  RUN_DO: DurableObjectNamespace;
  ADVANCE_QUEUE: Queue<AdvanceMessage>;
};

const TERMINAL_STATUSES = new Set(["completed", "failed", "waiting"]);
const CONFIG_RUN_PREFIX = "@configuration/";

export default {
  fetch(request, env) {
    return buildApp(env).fetch(request);
  },
  async queue(batch, env) {
    for (const message of batch.messages) {
      try {
        await dispatchAdvance(env, message.body);
        message.ack();
      } catch (error) {
        console.error("[advance-queue] failed", message.body, error);
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<WorkerEnv, AdvanceMessage>;

export type Env = WorkerEnv;

function buildApp(env: WorkerEnv) {
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
    deploymentBackend: createDefaultCloudflareDeploymentBackend(
      env,
      deploymentRegistry,
    ),
    onSaveRunDocument: (document) => {
      void fireRunSideEffects(env, document);
    },
    runSubscribe: (request, runId) => forwardToRunDO(env, runId, request),
  });
}

async function fireRunSideEffects(
  env: WorkerEnv,
  document: {
    runId: string;
    status: string;
    queue: { pending: unknown[] };
    workflow: { workflowId: string };
  },
): Promise<void> {
  const runId = document.runId;
  if (runId.startsWith(CONFIG_RUN_PREFIX)) return;

  try {
    await env.RUN_DO.get(env.RUN_DO.idFromName(runId)).fetch(
      "https://run-do/broadcast",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(document),
      },
    );
  } catch (error) {
    console.error("[run-side-effects] broadcast failed", runId, error);
  }

  const needsAdvance =
    document.queue.pending.length > 0 &&
    !TERMINAL_STATUSES.has(document.status);
  if (needsAdvance) {
    try {
      await env.ADVANCE_QUEUE.send({
        runId,
        deploymentId: document.workflow.workflowId,
      });
    } catch (error) {
      console.error("[run-side-effects] enqueue failed", runId, error);
    }
  }
}

async function dispatchAdvance(
  env: WorkerEnv,
  message: AdvanceMessage,
): Promise<void> {
  if (!env.DISPATCHER) {
    throw new Error("DISPATCHER binding is not configured.");
  }
  const url = `https://tenant/api/workflow/runs/${encodeURIComponent(
    message.runId,
  )}/advance`;
  const advanceRequest = new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const response = await env.DISPATCHER.get(message.deploymentId).fetch(
    advanceRequest,
  );
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`advance ${response.status}: ${text.slice(0, 200)}`);
  }
}

function forwardToRunDO(
  env: WorkerEnv,
  runId: string,
  request: Request,
): Promise<Response> {
  const id = env.RUN_DO.idFromName(runId);
  return env.RUN_DO.get(id).fetch(request);
}

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

export class RunDO {
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState, _env: WorkerEnv) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/broadcast" && request.method === "POST") {
      const payload = await request.text();
      for (const ws of this.state.getWebSockets()) {
        try {
          ws.send(payload);
        } catch (error) {
          console.error("[run-do] send failed", error);
        }
      }
      return new Response(null, { status: 204 });
    }

    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
      this.state.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("Not found", { status: 404 });
  }

  webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): void {
    try {
      ws.close();
    } catch {
      // ignore
    }
  }

  webSocketError(_ws: WebSocket, error: unknown): void {
    console.error("[run-do] websocket error", error);
  }
}
