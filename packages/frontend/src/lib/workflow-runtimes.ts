import { globalRegistry, type Registry, type RunState } from "@workflow/core";
import {
  LocalScheduler,
  MemoryEventSink,
  MemoryStateStore,
  MemoryWorkQueue,
  type RunSnapshot,
  RuntimeExecutor,
  StaticWorkflowLoader,
  type WorkflowRef,
} from "@workflow/runtime";

import type {
  RunStateDocument,
  RunSummary,
  StartWorkflowRunRequest,
  SubmitBackendInputRequest,
  SubmitBackendInterventionRequest,
  WorkflowRuntimeResult,
} from "../types";

export type StartWorkflowArgs = {
  inputId: string;
  payload: unknown;
  additionalInputs?: {
    inputId: string;
    payload: unknown;
  }[];
  secretBindings?: Record<string, string | { vaultEntryId: string }>;
  secretValues?: Record<string, string>;
  runId?: string;
};

export type SubmitWorkflowInputArgs = {
  state?: RunState;
  inputId: string;
  payload: unknown;
  secretValues?: Record<string, string>;
};

export type SubmitWorkflowInterventionArgs = {
  state?: RunState;
  interventionId: string;
  payload: unknown;
  secretValues?: Record<string, string>;
};

export type AdvanceWorkflowArgs = {
  state?: RunState;
  secretValues?: Record<string, string>;
};

export type PollWorkflowStateArgs = {
  runId: string;
};

export interface WorkflowRuntime {
  start(args: StartWorkflowArgs): Promise<WorkflowRuntimeResult>;
  submitInput(args: SubmitWorkflowInputArgs): Promise<WorkflowRuntimeResult>;
  submitIntervention(
    args: SubmitWorkflowInterventionArgs,
  ): Promise<WorkflowRuntimeResult>;
  advance(args: AdvanceWorkflowArgs): Promise<WorkflowRuntimeResult>;
  listRuns?(): Promise<RunSummary[]>;
  getState?(args: PollWorkflowStateArgs): Promise<WorkflowRuntimeResult>;
  reset?(): void;
}

export class BackendRuntime implements WorkflowRuntime {
  private readonly backendUrl: string;

  constructor(backendUrl = "/api") {
    this.backendUrl = backendUrl;
  }

  async listRuns(): Promise<RunSummary[]> {
    return this.get<RunSummary[]>("/runs");
  }

  async start(args: StartWorkflowArgs): Promise<WorkflowRuntimeResult> {
    const document = await this.post<StartWorkflowRunRequest, RunStateDocument>(
      "/runs",
      {
        inputId: args.inputId,
        payload: args.payload,
        additionalInputs: args.additionalInputs,
        secretBindings: args.secretBindings,
        secretValues: args.secretValues,
        runId: args.runId,
      },
    );
    return documentResult(document);
  }

  async submitInput(
    args: SubmitWorkflowInputArgs,
  ): Promise<WorkflowRuntimeResult> {
    if (!args.state)
      throw new Error("Cannot submit input before a run exists.");
    const document = await this.post<
      SubmitBackendInputRequest,
      RunStateDocument
    >(`/runs/${encodeURIComponent(args.state.runId)}/inputs`, {
      inputId: args.inputId,
      payload: args.payload,
      secretValues: args.secretValues,
    });
    return documentResult(document);
  }

  async submitIntervention(
    args: SubmitWorkflowInterventionArgs,
  ): Promise<WorkflowRuntimeResult> {
    if (!args.state)
      throw new Error("Cannot submit intervention before a run exists.");
    const document = await this.post<
      SubmitBackendInterventionRequest,
      RunStateDocument
    >(
      `/runs/${encodeURIComponent(args.state.runId)}/interventions/${encodeURIComponent(args.interventionId)}`,
      {
        payload: args.payload,
        secretValues: args.secretValues,
      },
    );
    return documentResult(document);
  }

  async advance(args: AdvanceWorkflowArgs): Promise<WorkflowRuntimeResult> {
    if (!args.state) throw new Error("Cannot advance before a run exists.");
    const document = await this.post<
      { secretValues?: Record<string, string> },
      RunStateDocument
    >(`/runs/${encodeURIComponent(args.state.runId)}/advance`, {
      secretValues: args.secretValues,
    });
    return documentResult(document);
  }

  async getState(args: PollWorkflowStateArgs): Promise<WorkflowRuntimeResult> {
    const document = await this.get<RunStateDocument>(
      `/state/${encodeURIComponent(args.runId)}`,
    );
    return documentResult(document);
  }

  private async post<TRequest, TResponse>(
    path: string,
    json: TRequest,
  ): Promise<TResponse> {
    const response = await fetch(`${this.backendUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(json),
    });
    return readJsonResponse<TResponse>(response);
  }

  private async get<TResponse>(path: string): Promise<TResponse> {
    const response = await fetch(`${this.backendUrl}${path}`);
    return readJsonResponse<TResponse>(response);
  }
}

async function readJsonResponse<TResponse>(
  response: Response,
): Promise<TResponse> {
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Workflow request failed: ${response.status}`);
  }

  return response.json() as Promise<TResponse>;
}

function documentResult(document: RunStateDocument): WorkflowRuntimeResult {
  return {
    state: document.state,
    snapshot: document,
    queue: document.queue,
    events: document.events,
  };
}

export type LocalRuntimeOptions = {
  registry?: Registry;
  workflow?: WorkflowRef;
  autoDrain?: boolean;
};

export class LocalRuntime implements WorkflowRuntime {
  private readonly registry: Registry;
  private readonly workflow: WorkflowRef;
  private events = new MemoryEventSink();
  private scheduler: LocalScheduler;

  constructor(options: LocalRuntimeOptions = {}) {
    this.registry = options.registry ?? globalRegistry;
    this.workflow = options.workflow ?? {
      workflowId: "client-workflow",
      version: "local",
    };
    this.scheduler = this.createScheduler();
  }

  reset(): void {
    this.events = new MemoryEventSink();
    this.scheduler = this.createScheduler();
  }

  async start(args: StartWorkflowArgs): Promise<WorkflowRuntimeResult> {
    const snapshot = await this.scheduler.startRun({
      workflow: this.workflow,
      input: {
        inputId: args.inputId,
        payload: args.payload,
      },
      additionalInputs: args.additionalInputs,
    });
    return this.result(snapshot);
  }

  async submitInput(
    args: SubmitWorkflowInputArgs,
  ): Promise<WorkflowRuntimeResult> {
    if (!args.state)
      throw new Error("Cannot submit input before a run exists.");
    const snapshot = await this.scheduler.submitInput({
      runId: args.state.runId,
      workflow: this.workflow,
      inputId: args.inputId,
      payload: args.payload,
    });
    return this.result(snapshot);
  }

  async submitIntervention(
    args: SubmitWorkflowInterventionArgs,
  ): Promise<WorkflowRuntimeResult> {
    if (!args.state)
      throw new Error("Cannot submit intervention before a run exists.");
    const snapshot = await this.scheduler.submitIntervention({
      runId: args.state.runId,
      workflow: this.workflow,
      interventionId: args.interventionId,
      payload: args.payload,
    });
    return this.result(snapshot);
  }

  async advance(args: AdvanceWorkflowArgs): Promise<WorkflowRuntimeResult> {
    if (!args.state) throw new Error("Cannot advance before a run exists.");
    await this.scheduler.processNext();
    const snapshot = await this.scheduler.snapshot(args.state.runId);
    return this.result(snapshot);
  }

  private result(snapshot: RunSnapshot): WorkflowRuntimeResult {
    return {
      state: snapshot.state,
      snapshot,
      queue: snapshot.queue,
      events: [...this.events.events],
    };
  }

  private createScheduler(): LocalScheduler {
    const loader = new StaticWorkflowLoader([
      {
        ref: this.workflow,
        registry: this.registry,
      },
    ]);
    return new LocalScheduler({
      loader,
      stateStore: new MemoryStateStore(),
      queue: new MemoryWorkQueue(),
      events: this.events,
      executor: new RuntimeExecutor(),
    });
  }
}
