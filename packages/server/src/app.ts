import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import {
  type BackendApiClientOptions,
  createBackendApiWorkflowQueue,
  createBackendApiWorkflowStateStore,
} from "./backend-api";
import { WorkflowManager, type WorkflowManagerOptions } from "./manager";
import {
  createWorkflowRoutes,
  mountWorkflowOpenApi,
  type WorkflowOpenApiOptions,
} from "./openapi";
import type {
  StartWorkflowRunRequest,
  SubmitWorkflowInputRequest,
  SubmitWorkflowInterventionRequest,
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
    executor: options.executor,
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

  app.openapi(routes.setAutoAdvance, async (c) => {
    try {
      const body = c.req.valid("json");
      return c.json(
        await manager.setAutoAdvance(requireParam(c.req.param("runId")), body),
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

export type WorkflowApp = ReturnType<typeof createWorkflow>;
