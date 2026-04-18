import { Hono } from "hono"

import type { WorkflowSession } from "./contracts.ts"

const rpc = new Hono()
  .get("/api/session", (c) => c.json({} as WorkflowSession))
  .post("/api/session/reset", (c) => c.json({} as WorkflowSession))
  .post("/api/session/input", (c) => c.json({} as WorkflowSession))

export type AppType = typeof rpc
