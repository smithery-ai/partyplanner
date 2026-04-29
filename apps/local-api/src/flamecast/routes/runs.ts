import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { RunAdvancer } from "../run-advancer.js";

const RunIdParam = z.object({
  runId: z.string().openapi({ param: { name: "runId", in: "path" } }),
});

const StartBody = z
  .object({
    workflowApiUrl: z.string().url().openapi({
      example: "https://demo-workflow.localhost/api/workflow",
    }),
    secretValues: z.record(z.string(), z.string()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .openapi("StartAdvanceBody");

const StartResponse = z
  .object({ runId: z.string(), started: z.boolean() })
  .openapi("StartAdvanceResponse");

const StopResponse = z
  .object({ runId: z.string(), stopped: z.boolean() })
  .openapi("StopAdvanceResponse");

const ListResponse = z
  .object({ runIds: z.array(z.string()) })
  .openapi("ListAdvancingRunsResponse");

const startAdvance = createRoute({
  method: "post",
  path: "/runs/{runId}/start-advance",
  tags: ["Runs"],
  summary: "Begin server-driven advance loop for a run",
  request: {
    params: RunIdParam,
    body: { content: { "application/json": { schema: StartBody } } },
  },
  responses: {
    200: {
      description: "Loop started (or already running)",
      content: { "application/json": { schema: StartResponse } },
    },
  },
});

const stopAdvance = createRoute({
  method: "post",
  path: "/runs/{runId}/stop-advance",
  tags: ["Runs"],
  summary: "Stop the advance loop for a run",
  request: { params: RunIdParam },
  responses: {
    200: {
      description: "Loop stopped (or was not running)",
      content: { "application/json": { schema: StopResponse } },
    },
  },
});

const listAdvancing = createRoute({
  method: "get",
  path: "/runs/advancing",
  tags: ["Runs"],
  summary: "List runs currently being advanced",
  responses: {
    200: {
      description: "List of run IDs",
      content: { "application/json": { schema: ListResponse } },
    },
  },
});

export function runRoutes(advancer: RunAdvancer) {
  const app = new OpenAPIHono();

  app.openapi(startAdvance, (c) => {
    const { runId } = c.req.valid("param");
    const body = c.req.valid("json");
    const result = advancer.start(runId, body);
    return c.json({ runId, ...result }, 200);
  });

  app.openapi(stopAdvance, (c) => {
    const { runId } = c.req.valid("param");
    const result = advancer.stop(runId);
    return c.json({ runId, ...result }, 200);
  });

  app.openapi(listAdvancing, (c) => {
    return c.json({ runIds: advancer.list() }, 200);
  });

  return app;
}
