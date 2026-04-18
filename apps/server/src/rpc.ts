import { Hono } from "hono"

import type { ProcessResponse, RunDetailResponse, RunListResponse, WorkflowFile, WorkflowFileList } from "./contracts.ts"

const rpc = new Hono()
  .get("/api/workflows", (c) => c.json({} as WorkflowFileList))
  .get("/api/workflows/:filename", (c) => c.json({} as WorkflowFile))
  .put("/api/workflows/:filename", (c) => c.json({} as WorkflowFile))
  .post("/api/workflows/:filename/process", (c) => c.json({} as ProcessResponse))
  .get("/api/workflows/:filename/runs", (c) => c.json({} as RunListResponse))
  .get("/api/workflows/:filename/runs/:runId", (c) => c.json({} as RunDetailResponse))

export type AppType = typeof rpc
