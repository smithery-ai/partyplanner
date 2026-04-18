import { globalRegistry, type Registry, type RunState } from "@rxwf/core"
import {
  LocalScheduler,
  MemoryEventSink,
  MemoryStateStore,
  MemoryWorkQueue,
  RuntimeExecutor,
  StaticWorkflowLoader,
  type QueueSnapshot,
  type RunEvent,
  type RunSnapshot,
  type WorkflowRef,
} from "@rxwf/runtime"

import type {
  RunStateDocument,
  StartBackendRunRequest,
  SubmitBackendInputRequest,
} from "../../../backend/src/rpc"

export type WorkflowRuntimeResult = {
  state: RunState
  snapshot?: RunSnapshot
  queue?: QueueSnapshot
  events?: RunEvent[]
}

export type StartWorkflowArgs = {
  workflowSource: string
  inputId: string
  payload: unknown
}

export type SubmitWorkflowInputArgs = {
  workflowSource: string
  state?: RunState
  inputId: string
  payload: unknown
}

export type AdvanceWorkflowArgs = {
  workflowSource: string
  state?: RunState
}

export type PollWorkflowStateArgs = {
  runId: string
}

export interface WorkflowRuntime {
  start(args: StartWorkflowArgs): Promise<WorkflowRuntimeResult>
  submitInput(args: SubmitWorkflowInputArgs): Promise<WorkflowRuntimeResult>
  advance(args: AdvanceWorkflowArgs): Promise<WorkflowRuntimeResult>
  getState?(args: PollWorkflowStateArgs): Promise<WorkflowRuntimeResult>
  reset?(): void
}

const backendUrl = import.meta.env.VITE_BACKEND_URL ?? "http://localhost:8787"

export class BackendRuntime implements WorkflowRuntime {
  async start(args: StartWorkflowArgs): Promise<WorkflowRuntimeResult> {
    const document = await this.post<StartBackendRunRequest, RunStateDocument>("/runs", {
      workflowSource: args.workflowSource,
      inputId: args.inputId,
      payload: args.payload,
    })
    return documentResult(document)
  }

  async submitInput(args: SubmitWorkflowInputArgs): Promise<WorkflowRuntimeResult> {
    if (!args.state) throw new Error("Cannot submit input before a run exists.")
    const document = await this.post<SubmitBackendInputRequest, RunStateDocument>(
      `/runs/${encodeURIComponent(args.state.runId)}/inputs`,
      {
        inputId: args.inputId,
        payload: args.payload,
      },
    )
    return documentResult(document)
  }

  async advance(args: AdvanceWorkflowArgs): Promise<WorkflowRuntimeResult> {
    if (!args.state) throw new Error("Cannot advance before a run exists.")
    const document = await this.post<Record<string, never>, RunStateDocument>(
      `/runs/${encodeURIComponent(args.state.runId)}/advance`,
      {},
    )
    return documentResult(document)
  }

  async getState(args: PollWorkflowStateArgs): Promise<WorkflowRuntimeResult> {
    const document = await this.get<RunStateDocument>(
      `/state/${encodeURIComponent(args.runId)}`,
    )
    return documentResult(document)
  }

  private async post<TRequest, TResponse>(path: string, json: TRequest): Promise<TResponse> {
    const response = await fetch(`${backendUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(json),
    })
    return readJsonResponse<TResponse>(response)
  }

  private async get<TResponse>(path: string): Promise<TResponse> {
    const response = await fetch(`${backendUrl}${path}`)
    return readJsonResponse<TResponse>(response)
  }
}

async function readJsonResponse<TResponse>(response: Response): Promise<TResponse> {
  if (!response.ok) {
    const message = await response.text()
    throw new Error(message || `Workflow request failed: ${response.status}`)
  }

  return response.json() as Promise<TResponse>
}

function documentResult(document: RunStateDocument): WorkflowRuntimeResult {
  return {
    state: document.state,
    snapshot: document,
    queue: document.queue,
    events: document.events,
  }
}

export type LocalRuntimeOptions = {
  registry?: Registry
  workflow?: WorkflowRef
  autoDrain?: boolean
}

export class LocalRuntime implements WorkflowRuntime {
  private readonly registry: Registry
  private readonly workflow: WorkflowRef
  private readonly autoDrain: boolean
  private events = new MemoryEventSink()
  private scheduler: LocalScheduler

  constructor(options: LocalRuntimeOptions = {}) {
    this.registry = options.registry ?? globalRegistry
    this.workflow = options.workflow ?? {
      workflowId: "client-workflow",
      version: "local",
    }
    this.autoDrain = options.autoDrain ?? true
    this.scheduler = this.createScheduler()
  }

  reset(): void {
    this.events = new MemoryEventSink()
    this.scheduler = this.createScheduler()
  }

  async start(args: StartWorkflowArgs): Promise<WorkflowRuntimeResult> {
    const snapshot = await this.scheduler.startRun({
      workflow: this.workflow,
      input: {
        inputId: args.inputId,
        payload: args.payload,
      },
    })
    return this.finalize(snapshot.runId, snapshot)
  }

  async submitInput(args: SubmitWorkflowInputArgs): Promise<WorkflowRuntimeResult> {
    if (!args.state) throw new Error("Cannot submit input before a run exists.")
    const snapshot = await this.scheduler.submitInput({
      runId: args.state.runId,
      workflow: this.workflow,
      inputId: args.inputId,
      payload: args.payload,
    })
    if (this.autoDrain) return this.finalize(snapshot.runId, snapshot)
    await this.scheduler.processNext()
    return this.result(await this.scheduler.snapshot(snapshot.runId))
  }

  async advance(args: AdvanceWorkflowArgs): Promise<WorkflowRuntimeResult> {
    if (!args.state) throw new Error("Cannot advance before a run exists.")
    await this.scheduler.processNext()
    const snapshot = await this.scheduler.snapshot(args.state.runId)
    return this.result(snapshot)
  }

  private async finalize(
    runId: string,
    snapshot: RunSnapshot,
  ): Promise<WorkflowRuntimeResult> {
    if (this.autoDrain) {
      await this.scheduler.drain()
      return this.result(await this.scheduler.snapshot(runId))
    }
    return this.result(snapshot)
  }

  private result(snapshot: RunSnapshot): WorkflowRuntimeResult {
    return {
      state: snapshot.state,
      snapshot,
      queue: snapshot.queue,
      events: [...this.events.events],
    }
  }

  private createScheduler(): LocalScheduler {
    const loader = new StaticWorkflowLoader([
      {
        ref: this.workflow,
        registry: this.registry,
      },
    ])
    return new LocalScheduler({
      loader,
      stateStore: new MemoryStateStore(),
      queue: new MemoryWorkQueue(),
      events: this.events,
      executor: new RuntimeExecutor(),
    })
  }
}
