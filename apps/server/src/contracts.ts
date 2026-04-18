import { z } from "@hono/zod-openapi"

export const nodeStatusSchema = z.enum([
  "resolved",
  "skipped",
  "waiting",
  "blocked",
  "errored",
  "not_reached",
])

export const nodeErrorSchema = z.object({
  message: z.string(),
  stack: z.string().optional(),
})

export const nodeRecordSchema = z.object({
  status: nodeStatusSchema,
  value: z.unknown().optional(),
  error: nodeErrorSchema.optional(),
  deps: z.array(z.string()),
  duration_ms: z.number(),
  blockedOn: z.string().optional(),
  waitingOn: z.string().optional(),
  attempts: z.number(),
})

export const runStateSchema = z.object({
  runId: z.string(),
  startedAt: z.number(),
  trigger: z.string().optional(),
  payload: z.unknown().optional(),
  inputs: z.record(z.string(), z.unknown()),
  nodes: z.record(z.string(), nodeRecordSchema),
  waiters: z.record(z.string(), z.array(z.string())),
  processedEventIds: z.record(z.string(), z.literal(true)),
})

export const errorResponseSchema = z.object({
  error: z.string(),
})

// ── Workflow file management ────────────────────────────────

export const workflowFileSchema = z.object({
  filename: z.string(),
  code: z.string(),
})

export const workflowFileListSchema = z.object({
  files: z.array(z.string()),
})

export const updateWorkflowCodeSchema = z.object({
  code: z.string(),
})

// ── Stateless process endpoint ──────────────────────────────

export const processRequestSchema = z.object({
  runState: runStateSchema.nullable(),
  inputId: z.string(),
  payload: z.unknown(),
})

export const processResponseSchema = z.object({
  runState: runStateSchema,
})

export type WorkflowFile = z.infer<typeof workflowFileSchema>
export type WorkflowFileList = z.infer<typeof workflowFileListSchema>
export type UpdateWorkflowCode = z.infer<typeof updateWorkflowCodeSchema>
// ── Run history ─────────────────────────────────────────────

export const runSummarySchema = z.object({
  runId: z.string(),
  filename: z.string(),
  startedAt: z.number(),
  nodeCount: z.number(),
  complete: z.boolean(),
})

export const runListResponseSchema = z.object({
  runs: z.array(runSummarySchema),
})

export const runDetailResponseSchema = z.object({
  runState: runStateSchema,
})

export type ProcessRequest = z.infer<typeof processRequestSchema>
export type ProcessResponse = z.infer<typeof processResponseSchema>
export type RunState = z.infer<typeof runStateSchema>
export type RunSummary = z.infer<typeof runSummarySchema>
export type RunListResponse = z.infer<typeof runListResponseSchema>
export type RunDetailResponse = z.infer<typeof runDetailResponseSchema>
