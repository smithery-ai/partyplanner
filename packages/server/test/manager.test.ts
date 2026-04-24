import type { QueueEvent } from "@workflow/core";
import { atom, globalRegistry, input } from "@workflow/core";
import type {
  QueueItem,
  QueueSnapshot,
  RunEvent,
  SaveResult,
  StoredRunState,
} from "@workflow/runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type {
  WorkflowQueue,
  WorkflowRunDocument,
  WorkflowRunSummary,
  WorkflowStateStore,
} from "../src";
import { WorkflowManager } from "../src";

describe("WorkflowManager", () => {
  beforeEach(() => {
    globalRegistry.clear();
  });

  afterEach(() => {
    globalRegistry.clear();
  });

  it("starts runs without draining queued work", async () => {
    const seed = input("seed", z.object({ value: z.number() }));
    atom(
      (get) => {
        const payload = get(seed);
        return payload.value + 1;
      },
      { name: "increment" },
    );

    const manager = new WorkflowManager({
      stateStore: new TestWorkflowStateStore(),
      queue: new TestWorkflowQueue(),
    });

    const started = await manager.startRun({
      inputId: "seed",
      payload: { value: 1 },
    });

    expect(started.status).toBe("running");
    expect(started.queue.pending).toHaveLength(1);
    expect(started.queue.pending[0]?.event.kind).toBe("input");

    const afterInput = await manager.advanceRun(started.runId);

    expect(afterInput.status).toBe("running");
    expect(afterInput.queue.pending).toHaveLength(1);
    expect(afterInput.queue.pending[0]?.event.kind).toBe("step");
    expect(
      afterInput.nodes.find((node) => node.id === "increment")?.status,
    ).toBe("queued");

    const completed = await manager.advanceRun(started.runId);

    expect(completed.status).toBe("completed");
    expect(completed.queue.pending).toHaveLength(0);
    expect(
      completed.nodes.find((node) => node.id === "increment")?.status,
    ).toBe("resolved");
  });

  it("matches all trigger inputs for a webhook-started run", async () => {
    input("leadA", z.object({ source: z.literal("webhook"), id: z.string() }));
    input("leadB", z.object({ source: z.literal("webhook"), id: z.string() }));

    const manager = new WorkflowManager({
      stateStore: new TestWorkflowStateStore(),
      queue: new TestWorkflowQueue(),
    });

    const started = await manager.submitWebhook(
      {
        payload: { source: "webhook", id: "evt_1" },
      },
      {
        method: "POST",
        url: "https://example.test/api/workflow/webhooks?source=test",
        route: "/api/workflow/webhooks",
        headers: {
          "content-type": "application/json",
          "x-test": "1",
        },
        query: {
          source: "test",
        },
      },
    );

    expect(started.status).toBe("running");
    expect(started.state.payload).toEqual({
      source: "webhook",
      id: "evt_1",
    });
    expect(started.state.webhook).toEqual({
      nodeId: "@workflow/webhook-payload",
      matchedInputs: ["leadA", "leadB"],
      receivedAt: started.state.webhook?.receivedAt,
    });
    expect(started.state.nodes["@workflow/webhook-payload"]).toMatchObject({
      status: "resolved",
      kind: "webhook",
      value: {
        method: "POST",
        route: "/api/workflow/webhooks",
        url: "https://example.test/api/workflow/webhooks?source=test",
        headers: {
          "content-type": "application/json",
          "x-test": "1",
        },
        query: {
          source: "test",
        },
        payload: { source: "webhook", id: "evt_1" },
      },
    });
    expect(
      started.events.map(
        (event) => event.type === "webhook_matched" && event.inputId,
      ),
    ).toContain("leadA");
    expect(
      started.events.map(
        (event) => event.type === "webhook_matched" && event.inputId,
      ),
    ).toContain("leadB");
    expect(
      started.queue.pending
        .filter((item) => item.event.kind === "input")
        .map((item) => item.event.inputId),
    ).toEqual(["leadA", "leadB"]);

    await manager.advanceRun(started.runId);
    const completed = await manager.advanceRun(started.runId);

    expect(completed.status).toBe("completed");
    expect(completed.state.inputs.leadA).toEqual({
      source: "webhook",
      id: "evt_1",
    });
    expect(completed.state.inputs.leadB).toEqual({
      source: "webhook",
      id: "evt_1",
    });
  });

  it("matches all deferred inputs for a waiting run", async () => {
    const seed = input("seed", z.object({ id: z.string() }));
    const approvalA = input.deferred(
      "approvalA",
      z.object({ approved: z.boolean() }),
    );
    const approvalB = input.deferred(
      "approvalB",
      z.object({ approved: z.boolean() }),
    );

    atom(
      (get) => {
        get(seed);
        return get(approvalA).approved;
      },
      { name: "checkApprovalA" },
    );
    atom(
      (get) => {
        get(seed);
        return get(approvalB).approved;
      },
      { name: "checkApprovalB" },
    );

    const manager = new WorkflowManager({
      stateStore: new TestWorkflowStateStore(),
      queue: new TestWorkflowQueue(),
    });

    const started = await manager.startRun({
      inputId: "seed",
      payload: { id: "seed_1" },
    });
    await manager.advanceRun(started.runId);
    await manager.advanceRun(started.runId);
    const waiting = await manager.advanceRun(started.runId);

    expect(waiting.status).toBe("waiting");

    const resumed = await manager.submitWebhook({
      runId: started.runId,
      payload: { approved: true },
    });

    expect(resumed.status).toBe("running");
    expect(resumed.state.inputs.approvalA).toEqual({ approved: true });
    expect(resumed.state.inputs.approvalB).toEqual({ approved: true });
    expect(
      resumed.events.map(
        (event) => event.type === "webhook_matched" && event.inputId,
      ),
    ).toContain("approvalA");
    expect(
      resumed.events.map(
        (event) => event.type === "webhook_matched" && event.inputId,
      ),
    ).toContain("approvalB");
    expect(
      resumed.queue.pending
        .filter((item) => item.event.kind === "step")
        .map((item) => item.event.stepId),
    ).toEqual(["checkApprovalA", "checkApprovalB"]);
  });

  it("fails runs when a webhook payload matches no unresolved input", async () => {
    input("lead", z.object({ kind: z.literal("lead") }));

    const manager = new WorkflowManager({
      stateStore: new TestWorkflowStateStore(),
      queue: new TestWorkflowQueue(),
    });

    const failed = await manager.submitWebhook({
      payload: { kind: "other" },
    });

    expect(failed.status).toBe("failed");
    expect(failed.queue.pending).toHaveLength(0);
    expect(failed.state.payload).toEqual({ kind: "other" });
    expect(failed.state.nodes["@workflow/webhook-payload"]).toMatchObject({
      status: "errored",
      kind: "webhook",
      value: {
        method: "POST",
        route: "/webhooks",
        headers: {},
        query: {},
        payload: { kind: "other" },
      },
      error: {
        message:
          "No unresolved workflow input matched the received webhook payload.",
      },
    });
    expect(failed.state.terminal).toEqual({
      status: "failed",
      reason: "webhook_unmatched",
    });
    expect(failed.events.map((event) => event.type)).toEqual([
      "run_started",
      "webhook_received",
      "webhook_unmatched",
      "run_failed",
    ]);

    const runs = await manager.listRuns();
    expect(runs[0]?.status).toBe("failed");
  });
});

class TestWorkflowStateStore implements WorkflowStateStore {
  private readonly runs = new Map<string, StoredRunState>();
  private readonly documents = new Map<string, WorkflowRunDocument>();
  private readonly events: RunEvent[] = [];

  async load(runId: string): Promise<StoredRunState | undefined> {
    const stored = this.runs.get(runId);
    if (!stored) return undefined;
    return {
      version: stored.version,
      state: structuredClone(stored.state),
    };
  }

  async save(
    runId: string,
    state: StoredRunState["state"],
    expectedVersion?: number,
  ): Promise<SaveResult> {
    const current = this.runs.get(runId);
    if (
      expectedVersion !== undefined &&
      current &&
      current.version !== expectedVersion
    ) {
      return { ok: false, reason: "conflict" };
    }
    if (expectedVersion !== undefined && !current && expectedVersion !== 0) {
      return { ok: false, reason: "missing" };
    }

    const version = (current?.version ?? 0) + 1;
    this.runs.set(runId, {
      version,
      state: structuredClone(state),
    });
    return { ok: true, version };
  }

  async publishEvent(event: RunEvent): Promise<void> {
    this.events.push(structuredClone(event));
  }

  async publishEvents(events: RunEvent[]): Promise<void> {
    for (const event of events) {
      await this.publishEvent(event);
    }
  }

  async listEvents(runId: string): Promise<RunEvent[]> {
    return this.events
      .filter((event) => event.runId === runId)
      .map((event) => structuredClone(event));
  }

  async saveRunDocument(document: WorkflowRunDocument): Promise<void> {
    this.documents.set(document.runId, structuredClone(document));
  }

  async getRunDocument(
    runId: string,
  ): Promise<WorkflowRunDocument | undefined> {
    const document = this.documents.get(runId);
    return document ? structuredClone(document) : undefined;
  }

  async listRunSummaries(workflowId?: string): Promise<WorkflowRunSummary[]> {
    return [...this.documents.values()]
      .filter((document) =>
        workflowId ? document.workflow.workflowId === workflowId : true,
      )
      .map((document) => ({
        runId: document.runId,
        status: document.status,
        startedAt: document.state.startedAt,
        publishedAt: document.publishedAt,
        triggerInputId: document.state.trigger,
        workflowId: document.workflow.workflowId,
        version: document.version,
        nodeCount: document.nodes.length,
        terminalNodeCount: document.nodes.filter((node) =>
          ["resolved", "skipped", "errored"].includes(node.status),
        ).length,
        waitingOn: document.nodes.flatMap((node) =>
          node.status === "waiting" && node.waitingOn ? [node.waitingOn] : [],
        ),
        failedNodeCount: document.nodes.filter(
          (node) => node.status === "errored",
        ).length,
      }));
  }
}

class TestWorkflowQueue implements WorkflowQueue {
  private readonly items: QueueItem[] = [];

  async enqueue(event: QueueEvent): Promise<void> {
    this.items.push({
      event: structuredClone(event),
      status: "pending",
      enqueuedAt: Date.now(),
    });
  }

  async enqueueMany(events: QueueEvent[]): Promise<void> {
    for (const event of events) {
      await this.enqueue(event);
    }
  }

  async claimNext(runId: string): Promise<QueueItem | undefined> {
    const item = this.items.find(
      (candidate) =>
        candidate.status === "pending" && candidate.event.runId === runId,
    );
    if (!item) return undefined;
    item.status = "running";
    item.startedAt = Date.now();
    return structuredClone(item);
  }

  async complete(eventId: string): Promise<void> {
    const item = this.items.find(
      (candidate) => candidate.event.eventId === eventId,
    );
    if (!item) return;
    item.status = "completed";
    item.finishedAt = Date.now();
  }

  async fail(eventId: string, error: Error): Promise<void> {
    const item = this.items.find(
      (candidate) => candidate.event.eventId === eventId,
    );
    if (!item) return;
    item.status = "failed";
    item.finishedAt = Date.now();
    item.error = error.message;
  }

  async snapshot(runId: string): Promise<QueueSnapshot> {
    const items = this.items
      .filter((item) => item.event.runId === runId)
      .map((item) => structuredClone(item));
    return {
      pending: items.filter((item) => item.status === "pending"),
      running: items.filter((item) => item.status === "running"),
      completed: items.filter((item) => item.status === "completed"),
      failed: items.filter((item) => item.status === "failed"),
    };
  }

  async size(runId: string): Promise<number> {
    return this.items.filter(
      (item) => item.event.runId === runId && item.status === "pending",
    ).length;
  }
}
