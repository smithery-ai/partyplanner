import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import type { RunState } from "./contracts.ts"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const runsDir = path.resolve(__dirname, "../data/runs")

function workflowRunsDir(filename: string): string {
  return path.join(runsDir, filename.replace(/\.ts$/, ""))
}

function runFilePath(filename: string, runId: string): string {
  return path.join(workflowRunsDir(filename), `${runId}.json`)
}

export type RunSummary = {
  runId: string
  filename: string
  startedAt: number
  nodeCount: number
  complete: boolean
}

function isRunComplete(state: RunState): boolean {
  const nodes = Object.values(state.nodes)
  if (nodes.length === 0) return false
  for (const node of nodes) {
    if (node.status === "waiting" || node.status === "blocked") return false
    if (node.status === "errored") return false
  }
  return true
}

export async function saveRun(
  filename: string,
  runState: RunState,
): Promise<void> {
  const dir = workflowRunsDir(filename)
  await mkdir(dir, { recursive: true })
  const filePath = runFilePath(filename, runState.runId)
  await writeFile(filePath, JSON.stringify(runState, null, 2))
}

export async function loadRun(
  filename: string,
  runId: string,
): Promise<RunState> {
  const filePath = runFilePath(filename, runId)
  const raw = await readFile(filePath, "utf8")
  return JSON.parse(raw) as RunState
}

export async function listRuns(filename: string): Promise<RunSummary[]> {
  const dir = workflowRunsDir(filename)
  await mkdir(dir, { recursive: true })

  const entries = await readdir(dir)
  const summaries: RunSummary[] = []

  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue
    try {
      const raw = await readFile(path.join(dir, entry), "utf8")
      const state = JSON.parse(raw) as RunState
      summaries.push({
        runId: state.runId,
        filename,
        startedAt: state.startedAt,
        nodeCount: Object.keys(state.nodes).length,
        complete: isRunComplete(state),
      })
    } catch {
      // skip corrupt files
    }
  }

  return summaries.sort((a, b) => b.startedAt - a.startedAt)
}
