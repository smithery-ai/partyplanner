import { OpenAPIHono, createRoute } from "@hono/zod-openapi"
import { z } from "@hono/zod-openapi"

import {
  processRequestSchema,
  processResponseSchema,
  runDetailResponseSchema,
  runListResponseSchema,
  updateWorkflowCodeSchema,
  workflowFileListSchema,
  workflowFileSchema,
} from "./contracts.ts"
import {
  getWorkflowCode,
  listWorkflowFiles,
  updateWorkflowCode,
} from "./workflow-store.ts"
import { processWorkflow } from "./workflow-runner.ts"
import { listRuns, loadRun } from "./run-store.ts"

const app = new OpenAPIHono()
const api = new OpenAPIHono()

app.onError((error, c) => {
  const message =
    error instanceof Error ? error.message : "Processing failed."
  return c.json({ error: message }, 400)
})

// ── Workflow file routes ────────────────────────────────────

const listWorkflowsRoute = createRoute({
  method: "get",
  path: "/workflows",
  tags: ["workflows"],
  responses: {
    200: {
      description: "List all workflow files",
      content: {
        "application/json": {
          schema: workflowFileListSchema,
        },
      },
    },
  },
})

const getWorkflowRoute = createRoute({
  method: "get",
  path: "/workflows/{filename}",
  tags: ["workflows"],
  request: {
    params: z.object({
      filename: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Get workflow file content",
      content: {
        "application/json": {
          schema: workflowFileSchema,
        },
      },
    },
  },
})

const updateWorkflowRoute = createRoute({
  method: "put",
  path: "/workflows/{filename}",
  tags: ["workflows"],
  request: {
    params: z.object({
      filename: z.string(),
    }),
    body: {
      required: true,
      content: {
        "application/json": {
          schema: updateWorkflowCodeSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Updated workflow file",
      content: {
        "application/json": {
          schema: workflowFileSchema,
        },
      },
    },
  },
})

// ── Stateless process route ─────────────────────────────────

const processRoute = createRoute({
  method: "post",
  path: "/workflows/{filename}/process",
  tags: ["workflows"],
  request: {
    params: z.object({
      filename: z.string(),
    }),
    body: {
      required: true,
      content: {
        "application/json": {
          schema: processRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Run state after processing the input event",
      content: {
        "application/json": {
          schema: processResponseSchema,
        },
      },
    },
  },
})

// ── Run history routes ──────────────────────────────────────

const listRunsRoute = createRoute({
  method: "get",
  path: "/workflows/{filename}/runs",
  tags: ["runs"],
  request: {
    params: z.object({
      filename: z.string(),
    }),
  },
  responses: {
    200: {
      description: "List historic runs for a workflow",
      content: {
        "application/json": {
          schema: runListResponseSchema,
        },
      },
    },
  },
})

const getRunRoute = createRoute({
  method: "get",
  path: "/workflows/{filename}/runs/{runId}",
  tags: ["runs"],
  request: {
    params: z.object({
      filename: z.string(),
      runId: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Get full run state for a historic run",
      content: {
        "application/json": {
          schema: runDetailResponseSchema,
        },
      },
    },
  },
})

// ── Handlers ────────────────────────────────────────────────

api.openapi(listWorkflowsRoute, async (c) => {
  const files = await listWorkflowFiles()
  return c.json({ files })
})

api.openapi(getWorkflowRoute, async (c) => {
  const { filename } = c.req.valid("param")
  const code = await getWorkflowCode(filename)
  return c.json({ filename, code })
})

api.openapi(updateWorkflowRoute, async (c) => {
  const { filename } = c.req.valid("param")
  const { code } = c.req.valid("json")
  await updateWorkflowCode(filename, code)
  return c.json({ filename, code })
})

api.openapi(processRoute, async (c) => {
  const { filename } = c.req.valid("param")
  const { runState, inputId, payload } = c.req.valid("json")
  const result = await processWorkflow(filename, runState, inputId, payload)
  return c.json(result)
})

api.openapi(listRunsRoute, async (c) => {
  const { filename } = c.req.valid("param")
  const runs = await listRuns(filename)
  return c.json({ runs })
})

api.openapi(getRunRoute, async (c) => {
  const { filename, runId } = c.req.valid("param")
  const runState = await loadRun(filename, runId)
  return c.json({ runState })
})

app.route("/api", api)
app.doc("/openapi.json", {
  openapi: "3.0.0",
  info: {
    title: "Workflow Server",
    version: "0.0.0",
  },
})

export default app
