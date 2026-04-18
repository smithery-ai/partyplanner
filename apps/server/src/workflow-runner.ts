import type { QueueEvent, RunState } from "@rxwf/core"
import { initWorkflows, getWorkflowEntry } from "../../client/src/workflows/loader.ts"
import { saveRun } from "./run-store.ts"

let initialized = false

async function ensureInit(): Promise<void> {
  if (initialized) return
  await initWorkflows()
  initialized = true
}

async function runToIdle(
  entry: ReturnType<typeof getWorkflowEntry> & {},
  seed: QueueEvent,
  state: RunState | undefined,
): Promise<RunState> {
  const queue = [seed]
  let current = state

  while (queue.length > 0) {
    const event = queue.shift()
    if (!event) break

    const result = await entry.runtime.process(event, current)
    current = result.state
    queue.push(...result.emitted)
  }

  return current!
}

export async function processWorkflow(
  filename: string,
  runState: RunState | null,
  inputId: string,
  payload: unknown,
): Promise<{ runState: RunState }> {
  await ensureInit()

  const entry = getWorkflowEntry(filename)
  if (!entry) {
    throw new Error(`Unknown workflow: ${filename}`)
  }

  const eventId = `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const runId = runState?.runId ?? `run-${Date.now()}`

  const nextState = await runToIdle(
    entry,
    {
      kind: "input",
      eventId,
      runId,
      inputId,
      payload,
    },
    runState ?? undefined,
  )

  await saveRun(filename, nextState)

  return { runState: nextState }
}
