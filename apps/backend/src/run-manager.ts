import type { QueueEvent } from "@rxwf/core";
import {
  LocalScheduler,
  MemoryEventSink,
  MemoryStateStore,
  MemoryWorkQueue,
  RuntimeExecutor,
  StaticWorkflowLoader,
} from "@rxwf/runtime";
import type {
  Executor,
  ExecuteRequest,
  ExecuteResult,
  QueueSnapshot,
  RunEvent,
  RunSnapshot,
  WorkflowRef,
} from "@rxwf/runtime";
import { evaluateWorkflowSource } from "./workflow-source";

export type StartBackendRunRequest = {
  workflowSource: string;
  inputId: string;
  payload: unknown;
  runId?: string;
};

export type SubmitBackendInputRequest = {
  inputId: string;
  payload: unknown;
};

export type RunStateDocument = RunSnapshot & {
  events: RunEvent[];
  publishedAt: number;
};

type RunController = {
  runId: string;
  workflow: WorkflowRef;
  scheduler: LocalScheduler;
  queue: MemoryWorkQueue;
  events: MemoryEventSink;
  processing: boolean;
  lastError?: string;
};

export class JsonStateManager {
  private readonly documents = new Map<string, RunStateDocument>();

  publish(snapshot: RunSnapshot, events: RunEvent[]): RunStateDocument {
    const document: RunStateDocument = {
      ...snapshot,
      events: structuredClone(events),
      publishedAt: Date.now(),
    };
    this.documents.set(snapshot.runId, structuredClone(document));
    return document;
  }

  get(runId: string): RunStateDocument | undefined {
    const document = this.documents.get(runId);
    return document ? structuredClone(document) : undefined;
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
      workflow,
      scheduler,
      queue,
      events,
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
    this.kickProcessing(controller);
    return document;
  }

  async submitInput(
    runId: string,
    request: SubmitBackendInputRequest,
  ): Promise<RunStateDocument> {
    const controller = this.requireRun(runId);
    await controller.scheduler.submitInput({
      runId,
      workflow: controller.workflow,
      inputId: request.inputId,
      payload: request.payload,
    });
    const document = await this.publishSnapshot(controller);
    this.kickProcessing(controller);
    return document;
  }

  async advanceRun(runId: string): Promise<RunStateDocument> {
    const controller = this.requireRun(runId);
    this.kickProcessing(controller);
    return this.publishSnapshot(controller);
  }

  getState(runId: string): RunStateDocument | undefined {
    return this.stateManager.get(runId);
  }

  private requireRun(runId: string): RunController {
    const controller = this.runs.get(runId);
    if (!controller) throw new Error(`Unknown run: ${runId}`);
    return controller;
  }

  private kickProcessing(controller: RunController): void {
    if (controller.processing) return;
    controller.processing = true;

    void (async () => {
      try {
        while ((await controller.queue.size()) > 0) {
          await controller.scheduler.processNext();
          await this.publishSnapshot(controller);
        }
        await this.publishSnapshot(controller);
      } catch (e) {
        controller.lastError = e instanceof Error ? e.message : String(e);
        await this.publishSnapshot(controller);
      } finally {
        controller.processing = false;
        if ((await controller.queue.size()) > 0) this.kickProcessing(controller);
      }
    })();
  }

  private async publishSnapshot(runId: string): Promise<RunStateDocument | undefined>;
  private async publishSnapshot(controller: RunController): Promise<RunStateDocument>;
  private async publishSnapshot(
    target: string | RunController,
  ): Promise<RunStateDocument | undefined> {
    const controller = typeof target === "string" ? this.runs.get(target) : target;
    if (!controller) return undefined;
    const snapshot = await controller.scheduler.snapshot(controller.runId);
    return this.stateManager.publish(
      withFailedStatus(snapshot, controller.lastError),
      controller.events.events.filter((event) => event.runId === controller.runId),
    );
  }
}

type DelayedExecutorOptions = {
  minMs?: number;
  maxMs?: number;
  onStepStarted?: (event: Extract<QueueEvent, { kind: "step" }>) => void | Promise<void>;
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

function withFailedStatus(snapshot: RunSnapshot, message: string | undefined): RunSnapshot {
  if (!message) return snapshot;
  const failedQueue: QueueSnapshot = {
    ...snapshot.queue,
    failed: snapshot.queue.failed.map((item) => ({ ...item, error: item.error ?? message })),
  };
  return {
    ...snapshot,
    status: "failed",
    queue: failedQueue,
  };
}
