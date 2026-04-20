import {
  atom,
  globalRegistry,
  input,
  type QueueEvent,
  secret,
} from "@workflow/core";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  LocalScheduler,
  MemoryEventSink,
  MemoryStateStore,
  MemoryWorkQueue,
  RuntimeExecutor,
  StaticWorkflowLoader,
  type WorkflowRef,
} from "../src";

const workflow: WorkflowRef = {
  workflowId: "test-workflow",
  version: "v1",
};

function makeScheduler(secretValues: Record<string, string> = {}) {
  const loader = new StaticWorkflowLoader([
    {
      ref: workflow,
      registry: globalRegistry,
    },
  ]);
  const stateStore = new MemoryStateStore();
  const queue = new MemoryWorkQueue();
  const events = new MemoryEventSink();
  const scheduler = new LocalScheduler({
    loader,
    stateStore,
    queue,
    events,
    executor: new RuntimeExecutor({
      async resolve({ logicalName }) {
        return secretValues[logicalName];
      },
    }),
  });
  return { scheduler, queue, events };
}

function queueNodeId(event: QueueEvent): string {
  return event.kind === "input" ? event.inputId : event.stepId;
}

describe("LocalScheduler", () => {
  beforeEach(() => {
    globalRegistry.clear();
  });

  it("keeps the work queue browser-visible before draining", async () => {
    input(
      "slack",
      z.object({
        message: z.string(),
      }),
    );

    const { scheduler, queue, events } = makeScheduler();
    const snapshot = await scheduler.startRun({
      workflow,
      runId: "run-visible-queue",
      input: {
        inputId: "slack",
        payload: { message: "hello" },
        eventId: "evt-slack",
      },
    });

    expect(snapshot.status).toBe("running");
    expect(snapshot.queue.pending).toHaveLength(1);
    expect(snapshot.queue.pending[0]?.event.kind).toBe("input");
    expect(await queue.size()).toBe(1);
    expect(events.events.map((event) => event.type)).toEqual([
      "run_started",
      "node_queued",
    ]);
  });

  it("injects bound secrets without storing plaintext in run state", async () => {
    const seed = input("seed", z.object({ name: z.string() }));
    const apiKey = secret("API_KEY", undefined);

    atom(
      (get) => {
        const initial = get(seed);
        const key = get(apiKey);
        return `${initial.name}:${key.slice(0, 2)}`;
      },
      { name: "useSecret" },
    );

    const { scheduler } = makeScheduler({ API_KEY: "sk-live" });
    const started = await scheduler.startRun({
      workflow,
      runId: "run-secret-start",
      input: {
        inputId: "seed",
        payload: { name: "Ada" },
        eventId: "evt-seed",
      },
    });

    expect(
      started.queue.pending.map((item) => queueNodeId(item.event)),
    ).toEqual(["seed"]);

    await scheduler.drain();
    const snapshot = await scheduler.snapshot("run-secret-start");

    expect(snapshot.status).toBe("completed");
    expect(snapshot.state.inputs.API_KEY).toBeUndefined();
    expect(snapshot.nodes.find((node) => node.id === "API_KEY")?.value).toBe(
      "[secret]",
    );
    expect(snapshot.nodes.find((node) => node.id === "useSecret")?.value).toBe(
      "Ada:sk",
    );
  });

  it("keeps secret dependency edges when a downstream step waits", async () => {
    const seed = input("seed", z.object({ name: z.string() }));
    const apiKey = secret("API_KEY", undefined);
    const approval = input.deferred(
      "approval",
      z.object({ approved: z.boolean() }),
    );

    atom(
      (get) => {
        const initial = get(seed);
        const key = get(apiKey);
        const ok = get(approval);
        if (!ok.approved) return get.skip("not approved");
        return `${initial.name}:${key.slice(0, 2)}`;
      },
      { name: "deploy" },
    );

    const { scheduler } = makeScheduler({ API_KEY: "sk-live" });
    await scheduler.startRun({
      workflow,
      runId: "run-secret-wait",
      input: {
        inputId: "seed",
        payload: { name: "Ada" },
        eventId: "evt-seed",
      },
    });

    await scheduler.drain();
    const snapshot = await scheduler.snapshot("run-secret-wait");

    expect(snapshot.status).toBe("waiting");
    expect(snapshot.nodes.find((node) => node.id === "deploy")?.deps).toEqual(
      expect.arrayContaining(["seed", "API_KEY", "approval"]),
    );
    expect(snapshot.edges).toEqual(
      expect.arrayContaining([
        { id: "API_KEY->deploy", source: "API_KEY", target: "deploy" },
        { id: "approval->deploy", source: "approval", target: "deploy" },
      ]),
    );
  });

  it("drains a linear workflow into a graph snapshot", async () => {
    const slack = input(
      "slack",
      z.object({
        message: z.string(),
        channel: z.string(),
      }),
    );

    const classify = atom(
      (get) => {
        const msg = get(slack);
        return msg.message.toLowerCase().includes("urgent")
          ? "urgent"
          : "normal";
      },
      { name: "classify" },
    );

    atom(
      (get) => {
        const priority = get(classify);
        const msg = get(slack);
        return `[${priority.toUpperCase()}] ${msg.channel}: ${msg.message}`;
      },
      { name: "format" },
    );

    const { scheduler, events } = makeScheduler();
    await scheduler.startRun({
      workflow,
      runId: "run-linear",
      input: {
        inputId: "slack",
        payload: { message: "Server is down URGENT", channel: "#ops" },
        eventId: "evt-slack",
      },
    });

    await scheduler.drain();
    const snapshot = await scheduler.snapshot("run-linear");

    expect(snapshot.status).toBe("completed");
    expect(snapshot.queue.pending).toHaveLength(0);
    expect(snapshot.queue.completed).toHaveLength(3);
    expect(snapshot.nodes.find((node) => node.id === "slack")?.status).toBe(
      "resolved",
    );
    expect(snapshot.nodes.find((node) => node.id === "classify")?.status).toBe(
      "resolved",
    );
    expect(snapshot.nodes.find((node) => node.id === "format")?.value).toBe(
      "[URGENT] #ops: Server is down URGENT",
    );
    expect(snapshot.edges).toEqual(
      expect.arrayContaining([
        { id: "slack->classify", source: "slack", target: "classify" },
        { id: "classify->format", source: "classify", target: "format" },
        { id: "slack->format", source: "slack", target: "format" },
      ]),
    );
    expect(
      events.events.some((event) => event.type === "edge_discovered"),
    ).toBe(true);
    expect(events.events.at(-1)?.type).toBe("run_completed");
  });

  it("pauses on deferred input and resumes only queued waiters", async () => {
    const expense = input(
      "expense",
      z.object({
        amount: z.number(),
        description: z.string(),
      }),
    );
    const approval = input.deferred(
      "approval",
      z.object({
        approved: z.boolean(),
      }),
    );

    const assessment = atom(
      (get) => {
        const e = get(expense);
        return e.amount > 1000 ? "high" : "low";
      },
      { name: "assessment" },
    );

    atom(
      (get) => {
        const e = get(expense);
        const risk = get(assessment);
        const decision = get(approval);
        if (!decision.approved) return get.skip("Approval was denied");
        return `submitted: ${e.description} (${risk})`;
      },
      { name: "submit" },
    );

    const { scheduler, events } = makeScheduler();
    await scheduler.startRun({
      workflow,
      runId: "run-deferred",
      input: {
        inputId: "expense",
        payload: { amount: 5000, description: "Conference tickets" },
        eventId: "evt-expense",
      },
    });

    await scheduler.drain();
    let snapshot = await scheduler.snapshot("run-deferred");

    expect(snapshot.status).toBe("waiting");
    expect(
      snapshot.nodes.find((node) => node.id === "assessment")?.status,
    ).toBe("resolved");
    expect(snapshot.nodes.find((node) => node.id === "submit")?.status).toBe(
      "waiting",
    );
    expect(snapshot.nodes.find((node) => node.id === "submit")?.waitingOn).toBe(
      "approval",
    );
    expect(snapshot.state.waiters.approval).toEqual(["submit"]);
    expect(events.events.at(-1)?.type).toBe("run_waiting");

    await scheduler.submitInput({
      runId: "run-deferred",
      inputId: "approval",
      payload: { approved: true },
      eventId: "evt-approval",
    });

    snapshot = await scheduler.snapshot("run-deferred");
    expect(snapshot.queue.pending).toHaveLength(1);
    expect(snapshot.queue.pending[0]?.event.kind).toBe("input");

    await scheduler.drain();
    snapshot = await scheduler.snapshot("run-deferred");

    expect(snapshot.status).toBe("completed");
    expect(snapshot.nodes.find((node) => node.id === "approval")?.status).toBe(
      "resolved",
    );
    expect(snapshot.nodes.find((node) => node.id === "submit")?.status).toBe(
      "resolved",
    );
    expect(snapshot.nodes.find((node) => node.id === "submit")?.value).toBe(
      "submitted: Conference tickets (high)",
    );
  });

  it("can resume deferred input one queue event at a time", async () => {
    const seed = input("seed", z.object({ name: z.string() }));
    const approval = input.deferred(
      "approval",
      z.object({ approved: z.boolean() }),
    );

    atom(
      (get) => {
        const s = get(seed);
        const a = get(approval);
        if (!a.approved) return get.skip("Approval was denied");
        return `approved ${s.name}`;
      },
      { name: "finish" },
    );

    const { scheduler } = makeScheduler();
    await scheduler.startRun({
      workflow,
      runId: "run-step-deferred",
      input: {
        inputId: "seed",
        payload: { name: "demo" },
        eventId: "evt-seed",
      },
    });

    await scheduler.drain();
    let snapshot = await scheduler.snapshot("run-step-deferred");
    expect(snapshot.status).toBe("waiting");
    expect(snapshot.nodes.find((node) => node.id === "finish")?.status).toBe(
      "waiting",
    );

    await scheduler.submitInput({
      runId: "run-step-deferred",
      inputId: "approval",
      payload: { approved: true },
      eventId: "evt-approval",
    });

    snapshot = await scheduler.snapshot("run-step-deferred");
    expect(snapshot.status).toBe("running");
    expect(snapshot.queue.pending).toHaveLength(1);
    expect(snapshot.queue.pending[0]?.event.kind).toBe("input");

    await scheduler.processNext();
    snapshot = await scheduler.snapshot("run-step-deferred");
    expect(snapshot.nodes.find((node) => node.id === "approval")?.status).toBe(
      "resolved",
    );
    expect(snapshot.nodes.find((node) => node.id === "finish")?.status).toBe(
      "queued",
    );
    expect(snapshot.queue.pending).toHaveLength(1);
    expect(snapshot.queue.pending[0]?.event.kind).toBe("step");

    await scheduler.processNext();
    snapshot = await scheduler.snapshot("run-step-deferred");
    expect(snapshot.status).toBe("completed");
    expect(snapshot.nodes.find((node) => node.id === "finish")?.value).toBe(
      "approved demo",
    );
  });

  it("includes skip reasons in graph snapshots and events", async () => {
    const request = input("request", z.object({ approved: z.boolean() }));

    atom(
      (get) => {
        const r = get(request);
        if (!r.approved) return get.skip("approval denied");
        return "approved";
      },
      { name: "gated" },
    );

    const { scheduler, events } = makeScheduler();
    await scheduler.startRun({
      workflow,
      runId: "run-skip-reason",
      input: {
        inputId: "request",
        payload: { approved: false },
        eventId: "evt-request",
      },
    });

    await scheduler.drain();
    const snapshot = await scheduler.snapshot("run-skip-reason");
    const node = snapshot.nodes.find((n) => n.id === "gated");
    const skipEvent = events.events.find(
      (event) => event.type === "node_skipped" && event.nodeId === "gated",
    );

    expect(node?.status).toBe("skipped");
    expect(node?.skipReason).toBe("approval denied");
    expect(skipEvent).toMatchObject({
      type: "node_skipped",
      nodeId: "gated",
      reason: "approval denied",
    });
  });
});
