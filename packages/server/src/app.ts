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
      const started = await manager.startRun(body);
      return c.json(
        await manager.advanceUntilSettled(started.runId, {
          secretValues: body.secretValues,
        }),
        200,
      );
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
      const runId = requireParam(c.req.param("runId"));
      await manager.submitInput(runId, body);
      return c.json(
        await manager.advanceUntilSettled(runId, {
          secretValues: body.secretValues,
        }),
        200,
      );
    } catch (e) {
      return c.json({ message: errorMessage(e) }, 400);
    }
  });

  app.openapi(routes.submitWebhook, async (c) => {
    try {
      const body = c.req.valid("json") as SubmitWorkflowWebhookRequest;
      const result = await manager.submitWebhook(
        body,
        webhookRequestContext(c.req.raw),
      );
      return c.json(await manager.advanceUntilSettled(result.runId), 200);
    } catch (e) {
      return c.json({ message: errorMessage(e) }, 400);
    }
  });

  app.openapi(routes.tickSchedules, async (c) => {
    try {
      const body = c.req.valid("json") as { at?: string };
      const at = body.at ? new Date(body.at) : new Date();
      if (Number.isNaN(at.getTime())) {
        return c.json({ message: `invalid 'at' timestamp: ${body.at}` }, 400);
      }
      const result = await manager.tickSchedules(at);
      for (const firing of result.fired) {
        try {
          await manager.advanceUntilSettled(firing.runId);
        } catch (e) {
          console.error(
            JSON.stringify({
              scope: "schedule_advance",
              level: "error",
              scheduleId: firing.id,
              runId: firing.runId,
              error: e instanceof Error ? e.message : String(e),
            }),
          );
        }
      }
      return c.json(result, 200);
    } catch (e) {
      return c.json({ message: errorMessage(e) }, 400);
    }
  });

  app.openapi(routes.runScheduleNow, async (c) => {
    const { scheduleId } = c.req.valid("param") as { scheduleId: string };
    try {
      const started = await manager.runScheduleNow(scheduleId);
      return c.json(await manager.advanceUntilSettled(started.runId), 200);
    } catch (e) {
      const message = errorMessage(e);
      if (/^Unknown schedule:/.test(message)) {
        return c.json({ message }, 404);
      }
      return c.json({ message }, 400);
    }
  });

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
      const runId = requireParam(c.req.param("runId"));
      await manager.submitIntervention(
        runId,
        requireParam(c.req.param("interventionId")),
        body,
      );
      return c.json(
        await manager.advanceUntilSettled(runId, {
          secretValues: body.secretValues,
        }),
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

function baseBackendUrl(backendApi: string | BackendApiClientOptions): string {
  const raw = typeof backendApi === "string" ? backendApi : backendApi.url;
  const trimmed = raw.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/runtime")
    ? trimmed.slice(0, -"/runtime".length)
    : trimmed;
}
export type WorkflowApp = ReturnType<typeof createWorkflow>;
