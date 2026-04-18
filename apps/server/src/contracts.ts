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

export const workflowSessionSchema = z.object({
  runId: z.string(),
  eventCounter: z.number().int().nonnegative(),
  runState: runStateSchema.nullable(),
})

export const submitInputSchema = z.object({
  inputId: z.string(),
  payload: z.unknown(),
})

export const errorResponseSchema = z.object({
  error: z.string(),
})

export type WorkflowSession = z.infer<typeof workflowSessionSchema>
export type SubmitInputRequest = z.infer<typeof submitInputSchema>
