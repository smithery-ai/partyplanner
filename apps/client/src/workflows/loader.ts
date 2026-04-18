import { Registry, setActiveRegistry, createRuntime, type Runtime } from "@rxwf/core"

export type WorkflowEntry = {
  filename: string
  registry: Registry
  runtime: Runtime
}

async function loadWorkflow(
  filename: string,
  importFn: () => Promise<unknown>,
): Promise<WorkflowEntry> {
  const registry = new Registry()
  setActiveRegistry(registry)
  await importFn()
  setActiveRegistry(null)
  return {
    filename,
    registry,
    runtime: createRuntime({ registry }),
  }
}

let _entries: WorkflowEntry[] | null = null
let _byFilename: Map<string, WorkflowEntry> | null = null

export async function initWorkflows(): Promise<void> {
  if (_entries) return

  // Sequential: each import must run with its own active registry.
  _entries = []
  _entries.push(await loadWorkflow("mcp-onboarding.ts", () => import("./mcp-onboarding")))
  _entries.push(await loadWorkflow("ci-pipeline.ts", () => import("./ci-pipeline")))
  _entries.push(await loadWorkflow("content-publishing.ts", () => import("./content-publishing")))
  _entries.push(await loadWorkflow("data-pipeline.ts", () => import("./data-pipeline")))
  _entries.push(await loadWorkflow("incident-response.ts", () => import("./incident-response")))
  _entries.push(await loadWorkflow("user-onboarding.ts", () => import("./user-onboarding")))

  _byFilename = new Map(_entries.map((e) => [e.filename, e]))
}

export function getWorkflowEntry(filename: string): WorkflowEntry | undefined {
  return _byFilename?.get(filename)
}

export function allWorkflowEntries(): WorkflowEntry[] {
  return _entries ?? []
}

export function allWorkflowFilenames(): string[] {
  return (_entries ?? []).map((e) => e.filename)
}
