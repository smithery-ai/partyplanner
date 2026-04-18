import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { createRuntime, type QueueEvent, type RunState } from "@rxwf/core"

import { type WorkflowSession, workflowSessionSchema } from "./contracts.ts"

import "../../client/src/workflow.ts"

const runtime = createRuntime()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.resolve(__dirname, "../data")
const sessionPath = path.join(dataDir, "session.json")

function defaultSession(): WorkflowSession {
  return {
    runId: "run-1",
    eventCounter: 0,
    runState: null,
  }
}

async function ensureDataDir(): Promise<void> {
  await mkdir(dataDir, { recursive: true })
}

export async function writeSession(session: WorkflowSession): Promise<void> {
  await ensureDataDir()
  await writeFile(sessionPath, JSON.stringify(session, null, 2))
}

export async function loadWorkflowSession(): Promise<WorkflowSession> {
  await ensureDataDir()

  try {
    const raw = await readFile(sessionPath, "utf8")
    return workflowSessionSchema.parse(JSON.parse(raw))
  } catch {
    const session = defaultSession()
    await writeSession(session)
    return session
  }
}

export async function resetWorkflowSession(): Promise<WorkflowSession> {
  const session = defaultSession()
  await writeSession(session)
  return session
}

async function runToIdle(
  seed: QueueEvent,
  state: RunState | null,
): Promise<RunState> {
  const queue = [seed]
  let current = state ?? undefined

  while (queue.length > 0) {
    const event = queue.shift()
    if (!event) break

    const result = await runtime.process(event, current)
    current = result.state
    queue.push(...result.emitted)
  }

  return current!
}

export async function submitWorkflowInput(params: {
  inputId: string
  payload: unknown
}): Promise<WorkflowSession> {
  const session = await loadWorkflowSession()
  const eventId = `evt-${session.eventCounter + 1}`

  const runState = await runToIdle(
    {
      kind: "input",
      eventId,
      runId: session.runId,
      inputId: params.inputId,
      payload: params.payload,
    },
    session.runState,
  )

  const nextSession: WorkflowSession = {
    ...session,
    eventCounter: session.eventCounter + 1,
    runState,
  }

  await writeSession(nextSession)
  return nextSession
}
