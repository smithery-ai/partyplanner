import { OpenAPIHono, createRoute } from "@hono/zod-openapi"

import {
  submitInputSchema,
  workflowSessionSchema,
} from "./contracts.ts"
import {
  loadWorkflowSession,
  resetWorkflowSession,
  submitWorkflowInput,
} from "./session-store.ts"

const app = new OpenAPIHono()
const api = new OpenAPIHono()
const endpointDelayMs = 2500

async function delayEndpoint(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, endpointDelayMs))
}

app.onError((error, c) => {
  const message =
    error instanceof Error ? error.message : "Processing failed."
  return c.json({ error: message }, 400)
})

const getSessionRoute = createRoute({
  method: "get",
  path: "/session",
  tags: ["workflow"],
  responses: {
    200: {
      description: "Current workflow session",
      content: {
        "application/json": {
          schema: workflowSessionSchema,
        },
      },
    },
  },
})

const resetSessionRoute = createRoute({
  method: "post",
  path: "/session/reset",
  tags: ["workflow"],
  responses: {
    200: {
      description: "Reset workflow session",
      content: {
        "application/json": {
          schema: workflowSessionSchema,
        },
      },
    },
  },
})

const submitInputRoute = createRoute({
  method: "post",
  path: "/session/input",
  tags: ["workflow"],
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: submitInputSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Session after processing an input event",
      content: {
        "application/json": {
          schema: workflowSessionSchema,
        },
      },
    },
  },
})

api.openapi(getSessionRoute, async (c) => {
  await delayEndpoint()
  const session = await loadWorkflowSession()
  return c.json(session)
})

api.openapi(resetSessionRoute, async (c) => {
  await delayEndpoint()
  const session = await resetWorkflowSession()
  return c.json(session)
})

api.openapi(submitInputRoute, async (c) => {
  await delayEndpoint()
  const { inputId, payload } = c.req.valid("json")
  const session = await submitWorkflowInput({ inputId, payload })
  return c.json(session, 200)
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
