import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import {
  BackendRunManager,
  JsonStateManager,
  type StartBackendRunRequest,
  type SubmitBackendInputRequest,
} from "./run-manager";

const NodeStatusSchema = z.enum([
  "resolved",
  "skipped",
  "waiting",
  "blocked",
  "errored",
  "not_reached",
]);

const NodeRecordSchema = z
  .object({
    status: NodeStatusSchema,
    value: z.any().optional(),
    error: z
      .object({
        message: z.string(),
        stack: z.string().optional(),
      })
      .optional(),
    deps: z.array(z.string()),
    duration_ms: z.number(),
    blockedOn: z.string().optional(),
    waitingOn: z.string().optional(),
    skipReason: z.string().optional(),
    attempts: z.number(),
  })
  .openapi("NodeRecord");

const RunStateSchema = z
  .object({
    runId: z.string(),
    startedAt: z.number(),
    trigger: z.string().optional(),
    payload: z.any().optional(),
    inputs: z.record(z.any()),
    nodes: z.record(NodeRecordSchema),
    waiters: z.record(z.array(z.string())),
    processedEventIds: z.record(z.literal(true)),
  })
  .openapi("RunState");

const ErrorSchema = z
  .object({
    message: z.string(),
  })
  .openapi("Error");

const PayloadSchema = z
  .union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(z.any()),
    z.record(z.any()),
  ])
  .openapi("JsonPayload");

const HealthResponseSchema = z.object({ ok: z.boolean() }).openapi("Health");

const WorkflowRefSchema = z
  .object({
    workflowId: z.string(),
    version: z.string(),
    codeHash: z.string().optional(),
  })
  .openapi("WorkflowRef");

const QueueEventSchema = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("input"),
      eventId: z.string(),
      runId: z.string(),
      inputId: z.string(),
      payload: PayloadSchema,
    }),
    z.object({
      kind: z.literal("step"),
      eventId: z.string(),
      runId: z.string(),
      stepId: z.string(),
    }),
  ])
  .openapi("QueueEvent");

const QueueItemSchema = z
  .object({
    event: QueueEventSchema,
    status: z.enum(["pending", "running", "completed", "failed"]),
    enqueuedAt: z.number(),
    startedAt: z.number().optional(),
    finishedAt: z.number().optional(),
    error: z.string().optional(),
  })
  .openapi("QueueItem");

const QueueSnapshotSchema = z
  .object({
    pending: z.array(QueueItemSchema),
    running: z.array(QueueItemSchema),
    completed: z.array(QueueItemSchema),
    failed: z.array(QueueItemSchema),
  })
  .openapi("QueueSnapshot");

const ExecutionStatusSchema = z.enum([
  "not_reached",
  "queued",
  "running",
  "resolved",
  "skipped",
  "waiting",
  "blocked",
  "errored",
]);

const RuntimeGraphNodeSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["input", "deferred_input", "atom"]),
    description: z.string().optional(),
    status: ExecutionStatusSchema,
    value: z.any().optional(),
    deps: z.array(z.string()),
    blockedOn: z.string().optional(),
    waitingOn: z.string().optional(),
    skipReason: z.string().optional(),
    attempts: z.number(),
  })
  .openapi("RuntimeGraphNode");

const RuntimeGraphEdgeSchema = z
  .object({
    id: z.string(),
    source: z.string(),
    target: z.string(),
  })
  .openapi("RuntimeGraphEdge");

const RunSnapshotSchema = z
  .object({
    runId: z.string(),
    workflow: WorkflowRefSchema,
    status: z.enum([
      "created",
      "running",
      "waiting",
      "completed",
      "failed",
      "canceled",
    ]),
    nodes: z.array(RuntimeGraphNodeSchema),
    edges: z.array(RuntimeGraphEdgeSchema),
    queue: QueueSnapshotSchema,
    state: RunStateSchema,
    version: z.number(),
  })
  .openapi("RunSnapshot");

const RunEventSchema = z
  .discriminatedUnion("type", [
    z.object({
      type: z.literal("run_started"),
      runId: z.string(),
      at: z.number(),
    }),
    z.object({
      type: z.literal("input_received"),
      runId: z.string(),
      inputId: z.string(),
      at: z.number(),
    }),
    z.object({
      type: z.literal("node_queued"),
      runId: z.string(),
      nodeId: z.string(),
      at: z.number(),
    }),
    z.object({
      type: z.literal("node_started"),
      runId: z.string(),
      nodeId: z.string(),
      at: z.number(),
    }),
    z.object({
      type: z.literal("edge_discovered"),
      runId: z.string(),
      source: z.string(),
      target: z.string(),
      at: z.number(),
    }),
    z.object({
      type: z.literal("node_resolved"),
      runId: z.string(),
      nodeId: z.string(),
      at: z.number(),
    }),
    z.object({
      type: z.literal("node_skipped"),
      runId: z.string(),
      nodeId: z.string(),
      reason: z.string().optional(),
      at: z.number(),
    }),
    z.object({
      type: z.literal("node_waiting"),
      runId: z.string(),
      nodeId: z.string(),
      waitingOn: z.string(),
      at: z.number(),
    }),
    z.object({
      type: z.literal("node_blocked"),
      runId: z.string(),
      nodeId: z.string(),
      blockedOn: z.string(),
      at: z.number(),
    }),
    z.object({
      type: z.literal("node_errored"),
      runId: z.string(),
      nodeId: z.string(),
      message: z.string(),
      at: z.number(),
    }),
    z.object({
      type: z.literal("run_completed"),
      runId: z.string(),
      at: z.number(),
    }),
    z.object({
      type: z.literal("run_waiting"),
      runId: z.string(),
      waitingOn: z.array(z.string()),
      at: z.number(),
    }),
  ])
  .openapi("RunEvent");

const RunStateDocumentSchema = RunSnapshotSchema.extend({
  events: z.array(RunEventSchema),
  publishedAt: z.number(),
  workflowSource: z.string(),
  autoAdvance: z.boolean(),
}).openapi("RunStateDocument");

const RunSummarySchema = z
  .object({
    runId: z.string(),
    status: z.enum([
      "created",
      "running",
      "waiting",
      "completed",
      "failed",
      "canceled",
    ]),
    startedAt: z.number(),
    publishedAt: z.number(),
    workflowId: z.string(),
    version: z.number(),
    nodeCount: z.number(),
    terminalNodeCount: z.number(),
    waitingOn: z.array(z.string()),
    failedNodeCount: z.number(),
  })
  .openapi("RunSummary");

const StartBackendRunRequestSchema = z
  .object({
    workflowSource: z.string(),
    inputId: z.string(),
    payload: PayloadSchema,
    runId: z.string().optional(),
    autoAdvance: z.boolean().optional(),
  })
  .openapi("StartBackendRunRequest");

const SubmitBackendInputRequestSchema = z
  .object({
    inputId: z.string(),
    payload: PayloadSchema,
    autoAdvance: z.boolean().optional(),
  })
  .openapi("SubmitBackendInputRequest");

const SetAutoAdvanceRequestSchema = z
  .object({
    autoAdvance: z.boolean(),
  })
  .openapi("SetAutoAdvanceRequest");

const RunIdParamSchema = z
  .object({
    runId: z.string(),
  })
  .openapi("RunIdParam");

const EmptyRequestSchema = z.object({}).openapi("EmptyRequest");

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: HealthResponseSchema,
        },
      },
      description: "Backend health status.",
    },
  },
});

const listRunsRoute = createRoute({
  method: "get",
  path: "/runs",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.array(RunSummarySchema),
        },
      },
      description: "Known workflow runs ordered by most recently published.",
    },
  },
});

const startRunRoute = createRoute({
  method: "post",
  path: "/runs",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: StartBackendRunRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: RunStateDocumentSchema,
        },
      },
      description: "Started workflow run snapshot.",
    },
    400: {
      content: {
        "application/json": {
          schema: ErrorSchema,
        },
      },
      description: "Invalid request or workflow source.",
    },
  },
});

const submitInputRoute = createRoute({
  method: "post",
  path: "/runs/{runId}/inputs",
  request: {
    params: RunIdParamSchema,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: SubmitBackendInputRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: RunStateDocumentSchema,
        },
      },
      description: "Workflow run snapshot after enqueuing input.",
    },
    400: {
      content: {
        "application/json": {
          schema: ErrorSchema,
        },
      },
      description: "Invalid request or unknown run.",
    },
  },
});

const advanceRunRoute = createRoute({
  method: "post",
  path: "/runs/{runId}/advance",
  request: {
    params: RunIdParamSchema,
    body: {
      required: false,
      content: {
        "application/json": {
          schema: EmptyRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: RunStateDocumentSchema,
        },
      },
      description: "Workflow run snapshot after processing one queued item.",
    },
    400: {
      content: {
        "application/json": {
          schema: ErrorSchema,
        },
      },
      description: "Unknown run or processing error.",
    },
  },
});

const setAutoAdvanceRoute = createRoute({
  method: "post",
  path: "/runs/{runId}/auto-advance",
  request: {
    params: RunIdParamSchema,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: SetAutoAdvanceRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: RunStateDocumentSchema,
        },
      },
      description: "Workflow run snapshot after changing advance mode.",
    },
    400: {
      content: {
        "application/json": {
          schema: ErrorSchema,
        },
      },
      description: "Invalid request or unknown run.",
    },
  },
});

const getRunStateRoute = createRoute({
  method: "get",
  path: "/state/{runId}",
  request: {
    params: RunIdParamSchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: RunStateDocumentSchema,
        },
      },
      description: "Latest published workflow run snapshot.",
    },
    404: {
      content: {
        "application/json": {
          schema: ErrorSchema,
        },
      },
      description: "Unknown run.",
    },
  },
});

const stateManager = new JsonStateManager();
const runManager = new BackendRunManager(stateManager);

export function createApp() {
  const app = new OpenAPIHono();

  app.use(
    "/*",
    cors({
      origin: "*",
      allowHeaders: ["Content-Type"],
      allowMethods: ["GET", "POST", "OPTIONS"],
    }),
  );
  const routes = app
    .openapi(healthRoute, (c) => c.json({ ok: true }, 200))
    .openapi(listRunsRoute, (c) => c.json(runManager.listRuns(), 200))
    .openapi(startRunRoute, async (c) => {
      try {
        const body = c.req.valid("json") as StartBackendRunRequest;
        const response = await runManager.startRun(body);
        return c.json(response, 200);
      } catch (e) {
        const err = e as Error;
        return c.json({ message: err.message }, 400);
      }
    })
    .openapi(submitInputRoute, async (c) => {
      try {
        const { runId } = c.req.valid("param");
        const body = c.req.valid("json") as SubmitBackendInputRequest;
        const response = await runManager.submitInput(runId, body);
        return c.json(response, 200);
      } catch (e) {
        const err = e as Error;
        return c.json({ message: err.message }, 400);
      }
    })
    .openapi(advanceRunRoute, async (c) => {
      try {
        const { runId } = c.req.valid("param");
        const response = await runManager.advanceRun(runId);
        return c.json(response, 200);
      } catch (e) {
        const err = e as Error;
        return c.json({ message: err.message }, 400);
      }
    })
    .openapi(setAutoAdvanceRoute, async (c) => {
      try {
        const { runId } = c.req.valid("param");
        const body = c.req.valid("json");
        const response = await runManager.setAutoAdvance(runId, body);
        return c.json(response, 200);
      } catch (e) {
        const err = e as Error;
        return c.json({ message: err.message }, 400);
      }
    })
    .openapi(getRunStateRoute, (c) => {
      const { runId } = c.req.valid("param");
      const document = runManager.getState(runId);
      if (!document) return c.json({ message: "Unknown run" }, 404);
      return c.json(document, 200);
    });

  const openApiOptions = {
    openapi: "3.0.0",
    info: {
      title: "Hylo Backend",
      version: "0.0.0",
    },
  } as const;

  routes.doc("/openapi", openApiOptions);
  routes.doc("/doc", openApiOptions);
  routes.get("/swagger", (c) => c.html(swaggerHtml("/openapi")));

  return routes;
}

function swaggerHtml(openApiUrl: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Hylo Backend API</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: ${JSON.stringify(openApiUrl)},
        dom_id: "#swagger-ui"
      });
    </script>
  </body>
</html>`;
}

export type AppType = ReturnType<typeof createApp>;
