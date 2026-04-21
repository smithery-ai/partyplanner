import { swaggerUI } from "@hono/swagger-ui";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Hono } from "hono";

export type RemoteRuntimeOpenApiOptions = {
  title?: string;
  version?: string;
  runtimeBasePath?: string;
  openApiPath?: string;
  swaggerPath?: string;
  servers?: { url: string; description?: string }[];
  includeRootHealth?: boolean;
};

export type RemoteRuntimeRoutes = ReturnType<typeof createRemoteRuntimeRoutes>;

const JsonContentType = "application/json";

const HealthResponseSchema = z
  .object({ ok: z.literal(true) })
  .openapi("HealthResponse");
const OkResponseSchema = z
  .object({ ok: z.literal(true) })
  .openapi("OkResponse");
const ErrorResponseSchema = z
  .object({ message: z.string() })
  .openapi("ErrorResponse");

const RunStateSchema = z.unknown().openapi("RunState", {
  description:
    "Serialized workflow run state. The exact graph shape is owned by @workflow/runtime.",
});
const RunEventSchema = z.unknown().openapi("RunEvent", {
  description:
    "Serialized workflow run event. Event variants are defined by @workflow/runtime.",
});
const QueueEventSchema = z.unknown().openapi("QueueEvent", {
  description:
    "Serialized workflow queue event. Event variants are defined by @workflow/core.",
});

const StoredRunStateSchema = z
  .object({
    state: RunStateSchema,
    version: z.number(),
  })
  .openapi("StoredRunState");

const SaveRunStateRequestSchema = z
  .object({
    state: RunStateSchema,
    expectedVersion: z.number().optional(),
  })
  .openapi("SaveRunStateRequest");

const SaveResultSchema = z
  .union([
    z.object({
      ok: z.literal(true),
      version: z.number(),
    }),
    z.object({
      ok: z.literal(false),
      reason: z.enum(["conflict", "missing"]),
    }),
  ])
  .openapi("SaveResult");

const WorkflowRunDocumentSchema = z
  .object({
    events: z.array(RunEventSchema),
    publishedAt: z.number(),
    autoAdvance: z.boolean(),
  })
  .catchall(z.unknown())
  .openapi("WorkflowRunDocument", {
    description:
      "Published workflow run document. The graph snapshot shape is owned by @workflow/runtime.",
  });

const WorkflowRunSummarySchema = z
  .object({
    runId: z.string(),
    status: z.string(),
    startedAt: z.number(),
    publishedAt: z.number(),
    triggerInputId: z.string().optional(),
    workflowId: z.string(),
    version: z.number(),
    nodeCount: z.number(),
    terminalNodeCount: z.number(),
    waitingOn: z.array(z.string()),
    failedNodeCount: z.number(),
  })
  .openapi("WorkflowRunSummary");

const PublishEventsRequestSchema = z
  .object({
    events: z.array(RunEventSchema).optional(),
  })
  .openapi("PublishEventsRequest");

const SaveRunDocumentRequestSchema = z
  .object({
    document: WorkflowRunDocumentSchema,
  })
  .openapi("SaveRunDocumentRequest");

const EnqueueEventsRequestSchema = z
  .object({
    events: z.array(QueueEventSchema).optional(),
  })
  .openapi("EnqueueEventsRequest");

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

const ClaimQueueItemResponseSchema = z
  .object({
    item: QueueItemSchema.nullable(),
  })
  .openapi("ClaimQueueItemResponse");

const FailQueueItemRequestSchema = z
  .object({
    message: z.string().optional(),
  })
  .openapi("FailQueueItemRequest");

const QueueSizeResponseSchema = z
  .object({
    size: z.number(),
  })
  .openapi("QueueSizeResponse");

const RunIdParamSchema = z.object({
  runId: z.string().openapi({
    param: { name: "runId", in: "path" },
  }),
});

const EventIdParamSchema = z.object({
  eventId: z.string().openapi({
    param: { name: "eventId", in: "path" },
  }),
});

const ListRunsQuerySchema = z.object({
  workflowId: z.string().optional(),
});

export function createRemoteRuntimeRoutes(basePath = "/runtime") {
  const normalizedBasePath = normalizeBasePath(basePath);

  return {
    health: createRoute({
      method: "get",
      path: path(normalizedBasePath, "/health"),
      tags: ["Runtime"],
      summary: "Check runtime health",
      responses: {
        200: jsonResponse("Runtime is healthy", HealthResponseSchema),
      },
    }),
    listRuns: createRoute({
      method: "get",
      path: path(normalizedBasePath, "/runs"),
      tags: ["Runs"],
      summary: "List run summaries",
      request: {
        query: ListRunsQuerySchema,
      },
      responses: {
        200: jsonResponse("Run summaries", z.array(WorkflowRunSummarySchema)),
      },
    }),
    getRunState: createRoute({
      method: "get",
      path: path(normalizedBasePath, "/runs/{runId}/state"),
      tags: ["State"],
      summary: "Load stored run state",
      request: {
        params: RunIdParamSchema,
      },
      responses: {
        200: jsonResponse("Stored run state", StoredRunStateSchema),
        404: jsonResponse("Run state was not found", ErrorResponseSchema),
      },
    }),
    saveRunState: createRoute({
      method: "put",
      path: path(normalizedBasePath, "/runs/{runId}/state"),
      tags: ["State"],
      summary: "Save run state",
      request: {
        params: RunIdParamSchema,
        body: jsonRequest(SaveRunStateRequestSchema),
      },
      responses: {
        200: jsonResponse("Save result", SaveResultSchema),
        400: jsonResponse("Invalid request", ErrorResponseSchema),
      },
    }),
    listRunEvents: createRoute({
      method: "get",
      path: path(normalizedBasePath, "/runs/{runId}/events"),
      tags: ["Events"],
      summary: "List run events",
      request: {
        params: RunIdParamSchema,
      },
      responses: {
        200: jsonResponse("Run events", z.array(RunEventSchema)),
      },
    }),
    publishEvents: createRoute({
      method: "post",
      path: path(normalizedBasePath, "/events"),
      tags: ["Events"],
      summary: "Publish run events",
      request: {
        body: jsonRequest(PublishEventsRequestSchema, false),
      },
      responses: {
        200: jsonResponse("Events were published", OkResponseSchema),
        400: jsonResponse("Invalid request", ErrorResponseSchema),
      },
    }),
    getRunDocument: createRoute({
      method: "get",
      path: path(normalizedBasePath, "/runs/{runId}/document"),
      tags: ["Documents"],
      summary: "Load run document",
      request: {
        params: RunIdParamSchema,
      },
      responses: {
        200: jsonResponse("Run document", WorkflowRunDocumentSchema),
        404: jsonResponse("Run document was not found", ErrorResponseSchema),
      },
    }),
    saveRunDocument: createRoute({
      method: "put",
      path: path(normalizedBasePath, "/runs/{runId}/document"),
      tags: ["Documents"],
      summary: "Save run document",
      request: {
        params: RunIdParamSchema,
        body: jsonRequest(SaveRunDocumentRequestSchema),
      },
      responses: {
        200: jsonResponse("Run document was saved", OkResponseSchema),
        400: jsonResponse("Invalid request", ErrorResponseSchema),
      },
    }),
    enqueueEvents: createRoute({
      method: "post",
      path: path(normalizedBasePath, "/queue/enqueue"),
      tags: ["Queue"],
      summary: "Enqueue queue events",
      request: {
        body: jsonRequest(EnqueueEventsRequestSchema, false),
      },
      responses: {
        200: jsonResponse("Events were enqueued", OkResponseSchema),
        400: jsonResponse("Invalid request", ErrorResponseSchema),
      },
    }),
    claimQueueItem: createRoute({
      method: "post",
      path: path(normalizedBasePath, "/queue/{runId}/claim"),
      tags: ["Queue"],
      summary: "Claim the next queue item for a run",
      request: {
        params: RunIdParamSchema,
      },
      responses: {
        200: jsonResponse("Claimed queue item", ClaimQueueItemResponseSchema),
      },
    }),
    completeQueueItem: createRoute({
      method: "post",
      path: path(normalizedBasePath, "/queue/{eventId}/complete"),
      tags: ["Queue"],
      summary: "Mark a queue item complete",
      request: {
        params: EventIdParamSchema,
      },
      responses: {
        200: jsonResponse("Queue item was completed", OkResponseSchema),
      },
    }),
    failQueueItem: createRoute({
      method: "post",
      path: path(normalizedBasePath, "/queue/{eventId}/fail"),
      tags: ["Queue"],
      summary: "Mark a queue item failed",
      request: {
        params: EventIdParamSchema,
        body: jsonRequest(FailQueueItemRequestSchema, false),
      },
      responses: {
        200: jsonResponse("Queue item was failed", OkResponseSchema),
        400: jsonResponse("Invalid request", ErrorResponseSchema),
      },
    }),
    queueSnapshot: createRoute({
      method: "get",
      path: path(normalizedBasePath, "/queue/{runId}/snapshot"),
      tags: ["Queue"],
      summary: "Load a queue snapshot for a run",
      request: {
        params: RunIdParamSchema,
      },
      responses: {
        200: jsonResponse("Queue snapshot", QueueSnapshotSchema),
      },
    }),
    queueSize: createRoute({
      method: "get",
      path: path(normalizedBasePath, "/queue/{runId}/size"),
      tags: ["Queue"],
      summary: "Load pending queue size for a run",
      request: {
        params: RunIdParamSchema,
      },
      responses: {
        200: jsonResponse("Queue size", QueueSizeResponseSchema),
      },
    }),
  };
}

export function createRemoteRuntimeOpenApiDocument(
  options: RemoteRuntimeOpenApiOptions = {},
): object {
  const app = createRemoteRuntimeOpenApiApp(options);

  return app.getOpenAPIDocument({
    openapi: "3.0.3",
    info: {
      title: options.title ?? "Hylo Backend API",
      version: options.version ?? "0.0.0",
    },
    ...(options.servers ? { servers: options.servers } : {}),
    tags: [
      { name: "Health" },
      { name: "Runtime" },
      { name: "Runs" },
      { name: "State" },
      { name: "Events" },
      { name: "Documents" },
      { name: "Queue" },
    ],
  });
}

export function mountRemoteRuntimeOpenApi(
  app: Hono,
  options: RemoteRuntimeOpenApiOptions = {},
): Hono {
  const openApiPath = normalizePath(options.openApiPath ?? "/openapi.json");
  const swaggerPath = normalizePath(options.swaggerPath ?? "/swagger");

  app.get(openApiPath, (c) =>
    c.json(createRemoteRuntimeOpenApiDocument(options)),
  );
  app.get(
    swaggerPath,
    swaggerUI({
      url: openApiPath,
      title: options.title ?? "Hylo Backend API",
    }),
  );

  return app;
}

function createRemoteRuntimeOpenApiApp(
  options: RemoteRuntimeOpenApiOptions,
): OpenAPIHono {
  const app = new OpenAPIHono();

  if (options.includeRootHealth ?? true) {
    app.openAPIRegistry.registerPath(
      createRoute({
        method: "get",
        path: "/health",
        tags: ["Health"],
        summary: "Check backend health",
        responses: {
          200: jsonResponse("Backend is healthy", HealthResponseSchema),
        },
      }),
    );
  }

  const routes = createRemoteRuntimeRoutes(
    options.runtimeBasePath ?? "/runtime",
  );
  for (const route of Object.values(routes)) {
    app.openAPIRegistry.registerPath(route);
  }

  return app;
}

function jsonRequest<TSchema extends z.ZodType>(
  schema: TSchema,
  required = true,
) {
  return {
    content: {
      [JsonContentType]: {
        schema,
      },
    },
    required,
  };
}

function jsonResponse<TSchema extends z.ZodType>(
  description: string,
  schema: TSchema,
) {
  return {
    description,
    content: {
      [JsonContentType]: {
        schema,
      },
    },
  };
}

function normalizeBasePath(basePath: string): string {
  const trimmed = basePath.trim();
  if (!trimmed || trimmed === "/") return "";
  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

function normalizePath(value: string): string {
  const normalized = normalizeBasePath(value);
  return normalized || "/";
}

function path(basePath: string, suffix: string): string {
  return `${basePath}${suffix}`;
}
