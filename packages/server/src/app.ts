import { OpenAPIHono } from "@hono/zod-openapi";
import { RuntimeExecutor, type SecretResolver } from "@workflow/runtime";
import { cors } from "hono/cors";
import {
  type BackendApiClientOptions,
  createBackendApiWorkflowQueue,
  createBackendApiWorkflowStateStore,
} from "./backend-api";
import {
  WorkflowManager,
  type WorkflowManagerOptions,
  type WorkflowWebhookRequestContext,
} from "./manager";
import {
  createWorkflowRoutes,
  mountWorkflowOpenApi,
  type WorkflowOpenApiOptions,
} from "./openapi";
import type {
  ClearManagedConnectionRequest,
  ConnectManagedConnectionRequest,
  StartWorkflowRunRequest,
  SubmitWorkflowInputRequest,
  SubmitWorkflowInterventionRequest,
  SubmitWorkflowWebhookRequest,
} from "./types";

export type CreateWorkflowOptions = Omit<
  WorkflowManagerOptions,
  "queue" | "stateStore"
> & {
  backendApi: string | BackendApiClientOptions;
  basePath?: string;
  openApi?: false | WorkflowOpenApiOptions;
};

export function createWorkflow(options: CreateWorkflowOptions) {
  const stateStore = createBackendApiWorkflowStateStore(options.backendApi);
  const queue = createBackendApiWorkflowQueue(options.backendApi);
  const manager = new WorkflowManager({
    stateStore,
    queue,
    registry: options.registry,
    executor:
      options.executor ??
      new RuntimeExecutor(defaultSecretResolver(options.backendApi)),
    workflow: options.workflow,
  });
  const app = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json({ message: result.error.message }, 400);
      }
    },
  });
  const basePath = normalizeBasePath(options.basePath);
  const routes = createWorkflowRoutes(basePath);

  app.use(
    "/*",
    cors({
      origin: "*",
      allowHeaders: ["Content-Type", "x-hylo-backend-url"],
      allowMethods: ["GET", "PUT", "POST", "OPTIONS"],
    }),
  );

  app.openapi(routes.health, (c) => c.json({ ok: true as const }, 200));
  app.openapi(routes.manifest, (c) => c.json(manager.manifest(), 200));
  app.openapi(routes.listRuns, async (c) =>
    c.json(await manager.listRuns(), 200),
  );
  app.openapi(routes.configuration, async (c) =>
    c.json(await manager.configuration(), 200),
  );

  app.openapi(routes.startRun, async (c) => {
    try {
      const body = c.req.valid("json") as StartWorkflowRunRequest;
      return c.json(await manager.startRun(body), 200);
    } catch (e) {
      return c.json({ message: errorMessage(e) }, 400);
    }
  });

  app.openapi(routes.getRun, async (c) => {
    const document = await manager.getRun(requireParam(c.req.param("runId")));
    if (!document) return c.json({ message: "Unknown run" }, 404);
    return c.json(document, 200);
  });

  app.openapi(routes.getRunState, async (c) => {
    const document = await manager.getRun(requireParam(c.req.param("runId")));
    if (!document) return c.json({ message: "Unknown run" }, 404);
    return c.json(document, 200);
  });

  app.openapi(routes.submitInput, async (c) => {
    try {
      const body = c.req.valid("json") as SubmitWorkflowInputRequest;
      return c.json(
        await manager.submitInput(requireParam(c.req.param("runId")), body),
        200,
      );
    } catch (e) {
      return c.json({ message: errorMessage(e) }, 400);
    }
  });

  app.openapi(routes.submitWebhook, async (c) => {
    try {
      const body = c.req.valid("json") as SubmitWorkflowWebhookRequest;
      return c.json(
        await manager.submitWebhook(body, webhookRequestContext(c.req.raw)),
        200,
      );
    } catch (e) {
      return c.json({ message: errorMessage(e) }, 400);
    }
  });

  app.get(`${basePath}/managed-connections/loading`, (c) =>
    c.html(MANAGED_CONNECTION_LOADING_HTML),
  );

  app.openapi(routes.connectManagedConnection, async (c) => {
    try {
      const body = c.req.valid("json") as ConnectManagedConnectionRequest;
      return c.json(
        await manager.connectManagedConnection(
          requireParam(c.req.param("connectionId")),
          body,
        ),
        200,
      );
    } catch (e) {
      return c.json({ message: errorMessage(e) }, 400);
    }
  });

  app.openapi(routes.clearManagedConnection, async (c) => {
    try {
      c.req.valid("json") as ClearManagedConnectionRequest;
      return c.json(
        await manager.clearManagedConnection(
          requireParam(c.req.param("connectionId")),
        ),
        200,
      );
    } catch (e) {
      return c.json({ message: errorMessage(e) }, 400);
    }
  });

  app.openapi(routes.submitIntervention, async (c) => {
    try {
      const body = c.req.valid("json") as SubmitWorkflowInterventionRequest;
      return c.json(
        await manager.submitIntervention(
          requireParam(c.req.param("runId")),
          requireParam(c.req.param("interventionId")),
          body,
        ),
        200,
      );
    } catch (e) {
      return c.json({ message: errorMessage(e) }, 400);
    }
  });

  app.openapi(routes.advanceRun, async (c) => {
    try {
      const body = c.req.valid("json");
      return c.json(
        await manager.advanceRun(requireParam(c.req.param("runId")), body),
        200,
      );
    } catch (e) {
      return c.json({ message: errorMessage(e) }, 400);
    }
  });

  if (options.openApi !== false) {
    mountWorkflowOpenApi(app, {
      ...options.openApi,
      basePath,
      definition: manager.definition,
    });
  }

  return app;
}

function normalizeBasePath(basePath: string | undefined): string {
  if (!basePath || basePath === "/") return "";
  return `/${basePath.replace(/^\/+|\/+$/g, "")}`;
}

function requireParam(value: string | undefined): string {
  if (value === undefined) throw new Error("Missing route parameter");
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function webhookRequestContext(
  request: Request,
): WorkflowWebhookRequestContext {
  const url = new URL(request.url);
  return {
    method: request.method,
    url: request.url,
    route: url.pathname,
    headers: Object.fromEntries(request.headers.entries()),
    query: Object.fromEntries(url.searchParams.entries()),
  };
}

function defaultSecretResolver(
  backendApi: string | BackendApiClientOptions,
): SecretResolver {
  const backendUrl = baseBackendUrl(backendApi);
  return {
    resolve: async ({ logicalName }) => {
      if (logicalName === "HYLO_BACKEND_URL") return backendUrl;
      return undefined;
    },
  };
}

const MANAGED_CONNECTION_LOADING_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Connecting…</title>
    <style>
      html, body {
        margin: 0;
        height: 100%;
        background: #fafafa;
        color: #18181b;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      }
      .wrap {
        height: 100%;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 16px;
      }
      .spinner {
        width: 28px;
        height: 28px;
        border: 2px solid #e4e4e7;
        border-top-color: #18181b;
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
      }
      .label {
        font-size: 14px;
        color: #71717a;
      }
      @keyframes spin { to { transform: rotate(360deg); } }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="spinner" aria-hidden="true"></div>
      <div class="label">Connecting…</div>
    </div>
  </body>
</html>`;

function baseBackendUrl(backendApi: string | BackendApiClientOptions): string {
  const raw = typeof backendApi === "string" ? backendApi : backendApi.url;
  const trimmed = raw.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/runtime")
    ? trimmed.slice(0, -"/runtime".length)
    : trimmed;
}
export type WorkflowApp = ReturnType<typeof createWorkflow>;
