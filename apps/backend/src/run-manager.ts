import type { QueueEvent } from "@rxwf/core";
import type {
  ExecuteRequest,
  ExecuteResult,
  Executor,
  QueueSnapshot,
  RunEvent,
  RunSnapshot,
  WorkflowRef,
} from "@rxwf/runtime";
import {
  LocalScheduler,
  MemoryEventSink,
  MemoryStateStore,
  MemoryWorkQueue,
  RuntimeExecutor,
  StaticWorkflowLoader,
} from "@rxwf/runtime";
import { evaluateWorkflowSource } from "./workflow-source";

export type StartBackendRunRequest = {
  workflowSource: string;
  inputId: string;
  payload: unknown;
  runId?: string;
  autoAdvance?: boolean;
};

export type SubmitBackendInputRequest = {
  inputId: string;
  payload: unknown;
  autoAdvance?: boolean;
};

export type SetAutoAdvanceRequest = {
  autoAdvance: boolean;
};

export type RunStateDocument = RunSnapshot & {
  events: RunEvent[];
  publishedAt: number;
  workflowSource: string;
  autoAdvance: boolean;
};

export type RunSummary = {
  runId: string;
  status: RunSnapshot["status"];
  startedAt: number;
  publishedAt: number;
  workflowId: string;
  version: number;
  nodeCount: number;
  terminalNodeCount: number;
  waitingOn: string[];
  failedNodeCount: number;
};

type RunController = {
  runId: string;
  workflowSource: string;
  workflow: WorkflowRef;
  scheduler: LocalScheduler;
  queue: MemoryWorkQueue;
  events: MemoryEventSink;
  autoAdvance: boolean;
  processing: boolean;
  lastError?: string;
};

export class JsonStateManager {
  private readonly documents = new Map<string, RunStateDocument>();

  publish(
    snapshot: RunSnapshot,
    events: RunEvent[],
    workflowSource: string,
    autoAdvance: boolean,
  ): RunStateDocument {
    const document: RunStateDocument = {
      ...snapshot,
      events: structuredClone(events),
      publishedAt: Date.now(),
      workflowSource,
      autoAdvance,
    };
    this.documents.set(snapshot.runId, structuredClone(document));
    return document;
  }

  get(runId: string): RunStateDocument | undefined {
    const document = this.documents.get(runId);
    return document ? structuredClone(document) : undefined;
  }

  list(): RunSummary[] {
    return [...this.documents.values()]
      .map((document) => summarizeRun(document))
      .sort((a, b) => b.publishedAt - a.publishedAt);
  }
}

export class BackendRunManager {
  private readonly runs = new Map<string, RunController>();

  constructor(private readonly stateManager: JsonStateManager) {}

  async startRun(request: StartBackendRunRequest): Promise<RunStateDocument> {
    const runId = request.runId ?? `run_${crypto.randomUUID()}`;
    const registry = evaluateWorkflowSource(request.workflowSource);
    const workflow: WorkflowRef = {
      workflowId: "backend-workflow",
      version: runId,
    };
    const loader = new StaticWorkflowLoader([{ ref: workflow, registry }]);
    const queue = new MemoryWorkQueue();
    const events = new MemoryEventSink();
    const stateStore = new MemoryStateStore();
    const scheduler = new LocalScheduler({
      loader,
      stateStore,
      queue,
      events,
      executor: new DelayedExecutor(new RuntimeExecutor(), {
        onStepStarted: async () => {
          await this.publishSnapshot(runId);
        },
      }),
    });
    const controller: RunController = {
      runId,
      workflowSource: request.workflowSource,
      workflow,
      scheduler,
      queue,
      events,
      autoAdvance: request.autoAdvance ?? true,
      processing: false,
    };
    this.runs.set(runId, controller);

    await scheduler.startRun({
      workflow,
      runId,
      input: {
        inputId: request.inputId,
        payload: request.payload,
      },
    });
    const document = await this.publishSnapshot(controller);
    if (controller.autoAdvance) this.kickProcessing(controller);
    return document;
  }

  async submitInput(
    runId: string,
    request: SubmitBackendInputRequest,
  ): Promise<RunStateDocument> {
    const controller = this.requireRun(runId);
    if (request.autoAdvance !== undefined) {
      controller.autoAdvance = request.autoAdvance;
    }
    await controller.scheduler.submitInput({
      runId,
      workflow: controller.workflow,
      inputId: request.inputId,
      payload: request.payload,
    });
    const document = await this.publishSnapshot(controller);
    if (controller.autoAdvance) this.kickProcessing(controller);
    return document;
  }

  async advanceRun(runId: string): Promise<RunStateDocument> {
    const controller = this.requireRun(runId);
    controller.autoAdvance = false;
    if (controller.processing) return this.publishSnapshot(controller);

    controller.processing = true;
    try {
      if ((await controller.queue.size()) > 0) {
        await controller.scheduler.processNext();
      }
      return await this.publishSnapshot(controller);
    } catch (e) {
      controller.lastError = e instanceof Error ? e.message : String(e);
      return await this.publishSnapshot(controller);
    } finally {
      controller.processing = false;
      if (controller.autoAdvance && (await controller.queue.size()) > 0) {
        this.kickProcessing(controller);
      }
    }
  }

  async setAutoAdvance(
    runId: string,
    request: SetAutoAdvanceRequest,
  ): Promise<RunStateDocument> {
    const controller = this.requireRun(runId);
    controller.autoAdvance = request.autoAdvance;
    if (controller.autoAdvance) this.kickProcessing(controller);
    return this.publishSnapshot(controller);
  }

  getState(runId: string): RunStateDocument | undefined {
    return this.stateManager.get(runId);
  }

  listRuns(): RunSummary[] {
    return this.stateManager.list();
  }

  private requireRun(runId: string): RunController {
    const controller = this.runs.get(runId);
    if (!controller) throw new Error(`Unknown run: ${runId}`);
    return controller;
  }

  private kickProcessing(controller: RunController): void {
    if (!controller.autoAdvance) return;
    if (controller.processing) return;
    controller.processing = true;

    void (async () => {
      try {
        while (controller.autoAdvance && (await controller.queue.size()) > 0) {
          await controller.scheduler.processNext();
          await this.publishSnapshot(controller);
        }
        await this.publishSnapshot(controller);
      } catch (e) {
        controller.lastError = e instanceof Error ? e.message : String(e);
        await this.publishSnapshot(controller);
      } finally {
        controller.processing = false;
        if (controller.autoAdvance && (await controller.queue.size()) > 0) {
          this.kickProcessing(controller);
        }
      }
    })();
  }

  private async publishSnapshot(
    runId: string,
  ): Promise<RunStateDocument | undefined>;
  private async publishSnapshot(
    controller: RunController,
  ): Promise<RunStateDocument>;
  private async publishSnapshot(
    target: string | RunController,
  ): Promise<RunStateDocument | undefined> {
    const controller =
      typeof target === "string" ? this.runs.get(target) : target;
    if (!controller) return undefined;
    const snapshot = await controller.scheduler.snapshot(controller.runId);
    return this.stateManager.publish(
      withFailedStatus(snapshot, controller.lastError),
      controller.events.events.filter(
        (event) => event.runId === controller.runId,
      ),
      controller.workflowSource,
      controller.autoAdvance,
    );
  }
}

type DelayedExecutorOptions = {
  minMs?: number;
  maxMs?: number;
  onStepStarted?: (
    event: Extract<QueueEvent, { kind: "step" }>,
  ) => void | Promise<void>;
};

class DelayedExecutor implements Executor {
  private readonly minMs: number;
  private readonly maxMs: number;

  constructor(
    private readonly delegate: Executor,
    private readonly options: DelayedExecutorOptions = {},
  ) {
    this.minMs = options.minMs ?? 1_000;
    this.maxMs = options.maxMs ?? 4_000;
  }

  async execute(request: ExecuteRequest): Promise<ExecuteResult> {
    if (request.event.kind === "step") {
      await this.options.onStepStarted?.(request.event);
      await sleep(randomDuration(this.minMs, this.maxMs));
    }
    return this.delegate.execute(request);
  }
}

function randomDuration(minMs: number, maxMs: number): number {
  return Math.floor(minMs + Math.random() * (maxMs - minMs + 1));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withFailedStatus(
  snapshot: RunSnapshot,
  message: string | undefined,
): RunSnapshot {
  if (!message) return snapshot;
  const failedQueue: QueueSnapshot = {
    ...snapshot.queue,
    failed: snapshot.queue.failed.map((item) => ({
      ...item,
      error: item.error ?? message,
    })),
  };
  return {
    ...snapshot,
    status: "failed",
    queue: failedQueue,
  };
}

function summarizeRun(document: RunStateDocument): RunSummary {
  const waitingOn = new Set<string>();
  let terminalNodeCount = 0;
  let failedNodeCount = 0;

  for (const node of document.nodes) {
    if (isTerminalSummaryNode(document, node)) terminalNodeCount += 1;
    if (node.status === "errored") failedNodeCount += 1;
    if (node.status === "waiting" && node.waitingOn)
      waitingOn.add(node.waitingOn);
  }

  return {
    runId: document.runId,
    status: document.status,
    startedAt: document.state.startedAt,
    publishedAt: document.publishedAt,
    workflowId: document.workflow.workflowId,
    version: document.version,
    nodeCount: document.nodes.length,
    terminalNodeCount,
    waitingOn: [...waitingOn],
    failedNodeCount,
  };
}

function isTerminalSummaryNode(
  document: RunStateDocument,
  node: RunStateDocument["nodes"][number],
): boolean {
  if (
    node.status === "resolved" ||
    node.status === "skipped" ||
    node.status === "errored"
  ) {
    return true;
  }
  return document.status === "completed" && node.kind === "deferred_input";
}
