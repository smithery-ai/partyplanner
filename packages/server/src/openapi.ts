import { swaggerUI } from "@hono/swagger-ui";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { WorkflowInputManifest, WorkflowManifest } from "./manifest";
import type { WorkflowServerDefinition } from "./types";

const JsonContentType = "application/json";

type JsonObject = Record<string, unknown>;
type OpenApiDocument = JsonObject & {
  paths?: Record<string, JsonObject>;
  components?: JsonObject & {
    schemas?: Record<string, unknown>;
  };
};

export type WorkflowOpenApiOptions = {
  title?: string;
  version?: string;
  openApiPath?: string;
  swaggerPath?: string;
  servers?: { url: string; description?: string }[];
};

export type WorkflowOpenApiMountOptions = WorkflowOpenApiOptions & {
  basePath?: string;
  definition: WorkflowServerDefinition;
};

export type WorkflowRoutes = ReturnType<typeof createWorkflowRoutes>;

const HealthResponseSchema = z
  .object({ ok: z.literal(true) })
  .openapi("HealthResponse");
const ErrorResponseSchema = z
  .object({ message: z.string() })
  .openapi("ErrorResponse");

const JsonSchemaSchema = z
  .record(z.string(), z.unknown())
  .openapi("JsonSchema");

const WorkflowInputManifestSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["input", "deferred_input"]),
    title: z.string().optional(),
    secret: z.boolean().optional(),
    description: z.string().optional(),
    schema: JsonSchemaSchema,
    resolved: z.boolean().optional(),
    errorMessage: z.string().optional(),
  })
  .openapi("WorkflowInputManifest");

const WorkflowStepManifestSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["atom", "action"]),
    description: z.string().optional(),
  })
  .openapi("WorkflowStepManifest");

const WorkflowManifestSchema = z
  .object({
    workflowId: z.string(),
    organizationId: z.string().optional(),
    version: z.string(),
    codeHash: z.string().optional(),
    name: z.string().optional(),
    createdAt: z.number(),
    inputs: z.array(WorkflowInputManifestSchema),
    atoms: z.array(WorkflowStepManifestSchema),
    actions: z.array(WorkflowStepManifestSchema),
  })
  .openapi("WorkflowManifest");

const WorkflowRefSchema = z
  .object({
    workflowId: z.string(),
    version: z.string(),
    codeHash: z.string().optional(),
    organizationId: z.string().optional(),
  })
  .openapi("WorkflowRef");

const RunEventSchema = z.unknown().openapi("RunEvent", {
  description:
    "Serialized workflow run event. Event variants are defined by @workflow/runtime.",
});
const QueueEventSchema = z.unknown().openapi("QueueEvent", {
  description:
    "Serialized workflow queue event. Event variants are defined by @workflow/core.",
});
const RunStateSchema = z.unknown().openapi("RunState", {
  description:
    "Serialized workflow run state. The exact graph shape is owned by @workflow/core.",
});

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

const GraphNodeSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["input", "deferred_input", "atom", "action"]),
    secret: z.boolean().optional(),
    description: z.string().optional(),
    status: z.enum([
      "not_reached",
      "queued",
      "running",
      "resolved",
      "skipped",
      "waiting",
      "blocked",
      "errored",
    ]),
    value: z.unknown().optional(),
    deps: z.array(z.string()),
    blockedOn: z.string().optional(),
    waitingOn: z.string().optional(),
    skipReason: z.string().optional(),
    attempts: z.number(),
  })
  .openapi("GraphNode");

const GraphEdgeSchema = z
  .object({
    id: z.string(),
    source: z.string(),
    target: z.string(),
  })
  .openapi("GraphEdge");

const WorkflowRunDocumentSchema = z
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
    nodes: z.array(GraphNodeSchema),
    edges: z.array(GraphEdgeSchema),
    queue: QueueSnapshotSchema,
    state: RunStateSchema,
    version: z.number(),
    events: z.array(RunEventSchema),
    publishedAt: z.number(),
  })
  .openapi("WorkflowRunDocument");

const WorkflowRunSummarySchema = z
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
    triggerInputId: z.string().optional(),
    workflowId: z.string(),
    version: z.number(),
    nodeCount: z.number(),
    terminalNodeCount: z.number(),
    waitingOn: z.array(z.string()),
    failedNodeCount: z.number(),
  })
  .openapi("WorkflowRunSummary");

const SecretBindingSchema = z.union([
  z.string(),
  z.object({ vaultEntryId: z.string() }),
]);

export const StartWorkflowRunRequestSchema = z
  .object({
    inputId: z.string(),
    payload: z.any(),
    additionalInputs: z
      .array(z.object({ inputId: z.string(), payload: z.any() }))
      .optional(),
    secretBindings: z.record(z.string(), SecretBindingSchema).optional(),
    secretValues: z.record(z.string(), z.string()).optional(),
    runId: z.string().optional(),
  })
  .openapi("StartWorkflowRunRequest");

export const SubmitWorkflowInputRequestSchema = z
  .object({
    inputId: z.string(),
    payload: z.any(),
    secretValues: z.record(z.string(), z.string()).optional(),
  })
  .openapi("SubmitWorkflowInputRequest");

export const SubmitWorkflowInterventionRequestSchema = z
  .object({
    payload: z.any(),
    secretValues: z.record(z.string(), z.string()).optional(),
  })
  .openapi("SubmitWorkflowInterventionRequest");

export const AdvanceWorkflowRunRequestSchema = z
  .object({
    secretValues: z.record(z.string(), z.string()).optional(),
  })
  .openapi("AdvanceWorkflowRunRequest");

const RunIdParamSchema = z.object({
  runId: z.string().openapi({
    param: { name: "runId", in: "path" },
  }),
});

const InterventionIdParamSchema = z.object({
  runId: z.string().openapi({
    param: { name: "runId", in: "path" },
  }),
  interventionId: z.string().openapi({
    param: { name: "interventionId", in: "path" },
  }),
});

export function createWorkflowRoutes(basePath = "/") {
  const normalizedBasePath = normalizeBasePath(basePath);

  return {
    health: createRoute({
      method: "get",
      path: path(normalizedBasePath, "/health"),
      tags: ["Health"],
      summary: "Check workflow API health",
      responses: {
        200: jsonResponse("Workflow API is healthy", HealthResponseSchema),
      },
    }),
    manifest: createRoute({
      method: "get",
      path: path(normalizedBasePath, "/manifest"),
      tags: ["Workflow"],
      summary: "Load workflow manifest",
      responses: {
        200: jsonResponse("Workflow manifest", WorkflowManifestSchema),
      },
    }),
    listRuns: createRoute({
      method: "get",
      path: path(normalizedBasePath, "/runs"),
      tags: ["Runs"],
      summary: "List workflow runs",
      responses: {
        200: jsonResponse(
          "Workflow run summaries",
          z.array(WorkflowRunSummarySchema),
        ),
      },
    }),
    startRun: createRoute({
      method: "post",
      path: path(normalizedBasePath, "/runs"),
      tags: ["Runs"],
      summary: "Start a workflow run",
      request: {
        body: jsonRequest(StartWorkflowRunRequestSchema),
      },
      responses: {
        200: jsonResponse("Started workflow run", WorkflowRunDocumentSchema),
        400: jsonResponse("Invalid request", ErrorResponseSchema),
      },
    }),
    getRun: createRoute({
      method: "get",
      path: path(normalizedBasePath, "/runs/{runId}"),
      tags: ["Runs"],
      summary: "Load a workflow run document",
      request: {
        params: RunIdParamSchema,
      },
      responses: {
        200: jsonResponse("Workflow run document", WorkflowRunDocumentSchema),
        404: jsonResponse("Run was not found", ErrorResponseSchema),
      },
    }),
    getRunState: createRoute({
      method: "get",
      path: path(normalizedBasePath, "/state/{runId}"),
      tags: ["Runs"],
      summary: "Load a workflow run document by state path",
      request: {
        params: RunIdParamSchema,
      },
      responses: {
        200: jsonResponse("Workflow run document", WorkflowRunDocumentSchema),
        404: jsonResponse("Run was not found", ErrorResponseSchema),
      },
    }),
    submitInput: createRoute({
      method: "post",
      path: path(normalizedBasePath, "/runs/{runId}/inputs"),
      tags: ["Inputs"],
      summary: "Submit a deferred input to a workflow run",
      request: {
        params: RunIdParamSchema,
        body: jsonRequest(SubmitWorkflowInputRequestSchema),
      },
      responses: {
        200: jsonResponse("Updated workflow run", WorkflowRunDocumentSchema),
        400: jsonResponse("Invalid request", ErrorResponseSchema),
      },
    }),
    submitIntervention: createRoute({
      method: "post",
      path: path(
        normalizedBasePath,
        "/runs/{runId}/interventions/{interventionId}",
      ),
      tags: ["Interventions"],
      summary: "Submit an intervention response to a workflow run",
      request: {
        params: InterventionIdParamSchema,
        body: jsonRequest(SubmitWorkflowInterventionRequestSchema),
      },
      responses: {
        200: jsonResponse("Updated workflow run", WorkflowRunDocumentSchema),
        400: jsonResponse("Invalid request", ErrorResponseSchema),
      },
    }),
    advanceRun: createRoute({
      method: "post",
      path: path(normalizedBasePath, "/runs/{runId}/advance"),
      tags: ["Runs"],
      summary: "Process the next queued workflow item",
      request: {
        params: RunIdParamSchema,
        body: jsonRequest(AdvanceWorkflowRunRequestSchema, false),
      },
      responses: {
        200: jsonResponse("Updated workflow run", WorkflowRunDocumentSchema),
        400: jsonResponse("Invalid request", ErrorResponseSchema),
      },
    }),
  };
}

export function mountWorkflowOpenApi(
  app: OpenAPIHono,
  options: WorkflowOpenApiMountOptions,
): OpenAPIHono {
  const basePath = normalizeBasePath(options.basePath ?? "/");
  const openApiPath = path(basePath, options.openApiPath ?? "/openapi.json");
  const swaggerPath = path(basePath, options.swaggerPath ?? "/swagger");

  app.get(openApiPath, (c) =>
    c.json(createWorkflowOpenApiDocument(app, options)),
  );
  app.get(
    swaggerPath,
    swaggerUI({
      url: openApiPath,
      title: openApiTitle(options),
    }),
  );

  return app;
}

export function createWorkflowOpenApiDocument(
  app: OpenAPIHono,
  options: WorkflowOpenApiMountOptions,
): object {
  const document = app.getOpenAPIDocument({
    openapi: "3.0.3",
    info: {
      title: openApiTitle(options),
      version: options.version ?? options.definition.manifest.version,
    },
    ...(options.servers ? { servers: options.servers } : {}),
    tags: [
      { name: "Health" },
      { name: "Workflow" },
      { name: "Runs" },
      { name: "Inputs" },
      { name: "Interventions" },
    ],
  }) as unknown as OpenApiDocument;

  return applyWorkflowInputSchemas(
    document,
    normalizeBasePath(options.basePath ?? "/"),
    options.definition.manifest,
  );
}

function applyWorkflowInputSchemas(
  document: OpenApiDocument,
  basePath: string,
  manifest: WorkflowManifest,
): OpenApiDocument {
  const inputSchemas = manifest.inputs.map((input) =>
    workflowInputRequestVariant(input),
  );
  if (inputSchemas.length === 0) return document;

  document.components ??= {};
  document.components.schemas ??= {};
  document.components.schemas.WorkflowInputRequest = { oneOf: inputSchemas };

  const startRunRequest = {
    allOf: [
      { $ref: "#/components/schemas/StartWorkflowRunRequest" },
      {
        type: "object",
        properties: {
          additionalInputs: {
            type: "array",
            items: { $ref: "#/components/schemas/WorkflowInputRequest" },
          },
        },
      },
      { $ref: "#/components/schemas/WorkflowInputRequest" },
    ],
  };
  const submitInputRequest = {
    allOf: [
      { $ref: "#/components/schemas/SubmitWorkflowInputRequest" },
      { $ref: "#/components/schemas/WorkflowInputRequest" },
    ],
  };

  setJsonRequestSchema(
    document,
    path(basePath, "/runs"),
    "post",
    startRunRequest,
  );
  setJsonRequestSchema(
    document,
    path(basePath, "/runs/{runId}/inputs"),
    "post",
    submitInputRequest,
  );

  return document;
}

function workflowInputRequestVariant(input: WorkflowInputManifest): JsonObject {
  return {
    type: "object",
    required: ["inputId", "payload"],
    properties: {
      inputId: {
        type: "string",
        enum: [input.id],
        ...(input.title || input.description
          ? { description: input.description ?? input.title }
          : {}),
      },
      payload: cloneJsonSchema(input.schema),
    },
  };
}

function setJsonRequestSchema(
  document: OpenApiDocument,
  routePath: string,
  method: string,
  schema: JsonObject,
): void {
  const operation = document.paths?.[routePath]?.[method];
  if (!isJsonObject(operation)) return;
  const requestBody = operation.requestBody;
  if (!isJsonObject(requestBody)) return;
  const content = requestBody.content;
  if (!isJsonObject(content)) return;
  const jsonContent = content[JsonContentType];
  if (!isJsonObject(jsonContent)) return;
  jsonContent.schema = schema;
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

function openApiTitle(options: WorkflowOpenApiMountOptions): string {
  return (
    options.title ??
    `${options.definition.manifest.name ?? options.definition.ref.workflowId} Workflow API`
  );
}

function cloneJsonSchema(schema: JsonObject): JsonObject {
  return structuredClone(schema);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeBasePath(basePath: string): string {
  const trimmed = basePath.trim();
  if (!trimmed || trimmed === "/") return "";
  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

function path(basePath: string, routePath: string): string {
  const normalizedPath = normalizeBasePath(routePath);
  return `${basePath}${normalizedPath || "/"}`;
}
