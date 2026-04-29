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

function makeScheduler(
  secretValues: Record<string, string> = {},
  queue: MemoryWorkQueue = new MemoryWorkQueue(),
) {
  const loader = new StaticWorkflowLoader([
    {
      ref: workflow,
      registry: globalRegistry,
    },
  ]);
  const stateStore = new MemoryStateStore();
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
  return { scheduler, stateStore, queue, events };
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

  it("saves processed input state before enqueueing emitted follow-up work", async () => {
    const seed = input("seed", z.object({ name: z.string() }));

    atom(
      (get) => {
        const initial = get(seed);
        return `hello ${initial.name}`;
      },
      { name: "greet" },
    );

    class FailingFollowupQueue extends MemoryWorkQueue {
      async enqueueMany(events: QueueEvent[]): Promise<void> {
        if (events.some((event) => event.kind === "step")) {
          throw new Error("queue write failed");
        }
        return super.enqueueMany(events);
      }
    }

    const { scheduler, stateStore } = makeScheduler(
      {},
      new FailingFollowupQueue(),
    );
    await scheduler.startRun({
      workflow,
      runId: "run-queue-failure",
      input: {
        inputId: "seed",
        payload: { name: "Ada" },
        eventId: "evt-seed",
      },
    });

    await expect(scheduler.processNext()).rejects.toThrow("queue write failed");

    const stored = await stateStore.load("run-queue-failure");
    expect(stored?.state.trigger).toBe("seed");
    expect(stored?.state.inputs.seed).toEqual({ name: "Ada" });
    expect(stored?.state.nodes.seed?.status).toBe("resolved");
    expect(stored?.state.processedEventIds["evt-seed"]).toBe(true);
  });

  it("recovers a missing trigger from queue history before processing steps", async () => {
    const seed = input("seed", z.object({ name: z.string() }));

    atom(
      (get) => {
        const initial = get(seed);
        return `hello ${initial.name}`;
      },
      { name: "greet" },
    );

    const { scheduler, queue } = makeScheduler();
    await scheduler.startRun({
      workflow,
      runId: "run-missing-trigger",
    });
    await queue.enqueue({
      kind: "input",
      eventId: "evt-seed",
      runId: "run-missing-trigger",
      inputId: "seed",
      payload: { name: "Ada" },
    });
    await queue.fail("evt-seed", new Error("failed before state save"));
    await queue.enqueue({
      kind: "step",
      eventId: "evt-greet",
      runId: "run-missing-trigger",
      stepId: "greet",
    });

    await scheduler.processNext();
    let snapshot = await scheduler.snapshot("run-missing-trigger");

    expect(snapshot.state.trigger).toBe("seed");
    expect(snapshot.nodes.find((node) => node.id === "seed")?.status).toBe(
      "resolved",
    );
    expect(snapshot.nodes.find((node) => node.id === "greet")?.value).toBe(
      "hello Ada",
    );

    await scheduler.drain();
    snapshot = await scheduler.snapshot("run-missing-trigger");
    expect(snapshot.status).toBe("completed");
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

  it("resolves deferred input immediately and resumes only queued waiters", async () => {
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
    expect(snapshot.nodes.find((node) => node.id === "approval")?.status).toBe(
      "resolved",
    );
    expect(snapshot.queue.pending).toHaveLength(1);
    expect(snapshot.queue.pending[0]?.event.kind).toBe("step");
    expect(snapshot.queue.pending[0]?.event).toMatchObject({
      stepId: "submit",
    });

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

  it("queues the waiting step immediately when deferred input is submitted", async () => {
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
    expect(snapshot.nodes.find((node) => node.id === "approval")?.status).toBe(
      "resolved",
    );
    expect(snapshot.queue.pending).toHaveLength(1);
    expect(snapshot.queue.pending[0]?.event.kind).toBe("step");
    expect(snapshot.nodes.find((node) => node.id === "finish")?.status).toBe(
      "queued",
    );

    await scheduler.processNext();
    snapshot = await scheduler.snapshot("run-step-deferred");
    expect(snapshot.status).toBe("completed");
    expect(snapshot.nodes.find((node) => node.id === "finish")?.value).toBe(
      "approved demo",
    );
  });

  it("stores deferred input immediately without re-running unrelated steps", async () => {
    const seed = input("seed", z.object({ name: z.string() }));
    input.deferred("approval", z.object({ approved: z.boolean() }));
    let greetCalls = 0;

    atom(
      (get) => {
        const s = get(seed);
        greetCalls += 1;
        return `hello ${s.name}`;
      },
      { name: "greet" },
    );

    const { scheduler } = makeScheduler();
    await scheduler.startRun({
      workflow,
      runId: "run-deferred-ref",
      input: {
        inputId: "seed",
        payload: { name: "Ada" },
        eventId: "evt-seed",
      },
    });

    await scheduler.drain();
    let snapshot = await scheduler.snapshot("run-deferred-ref");
    expect(snapshot.status).toBe("completed");
    expect(greetCalls).toBe(1);

    snapshot = await scheduler.submitInput({
      runId: "run-deferred-ref",
      inputId: "approval",
      payload: { approved: true },
      eventId: "evt-approval",
    });

    expect(snapshot.status).toBe("completed");
    expect(snapshot.state.inputs.approval).toEqual({ approved: true });
    expect(snapshot.nodes.find((node) => node.id === "approval")?.status).toBe(
      "resolved",
    );
    expect(snapshot.queue.pending).toHaveLength(0);
    expect(greetCalls).toBe(1);
  });

  it("blocks downstream steps on waiting dependencies and resumes them when the dependency resolves", async () => {
    const seed = input("seed", z.object({ name: z.string() }));

    const review = atom(
      (get, requestIntervention) => {
        const s = get(seed);
        const approval = requestIntervention(
          "approval",
          z.object({ approved: z.boolean() }),
        );
        if (!approval.approved) return get.skip("review denied");
        return `reviewed:${s.name}`;
      },
      { name: "review" },
    );

    atom(
      (get) => {
        const result = get(review);
        return `wrap:${result}`;
      },
      { name: "wrap" },
    );

    const { scheduler } = makeScheduler();
    await scheduler.startRun({
      workflow,
      runId: "run-wait-propagation",
      input: {
        inputId: "seed",
        payload: { name: "Ada" },
        eventId: "evt-seed",
      },
    });

    await scheduler.drain();
    let snapshot = await scheduler.snapshot("run-wait-propagation");
    const interventionId = "review:approval";

    expect(snapshot.status).toBe("waiting");
    expect(snapshot.nodes.find((node) => node.id === "review")?.status).toBe(
      "waiting",
    );
    expect(snapshot.nodes.find((node) => node.id === "review")?.waitingOn).toBe(
      interventionId,
    );
    expect(snapshot.nodes.find((node) => node.id === "wrap")?.status).toBe(
      "blocked",
    );
    expect(snapshot.nodes.find((node) => node.id === "wrap")?.blockedOn).toBe(
      "review",
    );

    await scheduler.submitIntervention({
      runId: "run-wait-propagation",
      interventionId,
      payload: { approved: true },
    });

    await scheduler.drain();
    snapshot = await scheduler.snapshot("run-wait-propagation");

    expect(snapshot.status).toBe("completed");
    expect(snapshot.nodes.find((node) => node.id === "review")?.value).toBe(
      "reviewed:Ada",
    );
    expect(snapshot.nodes.find((node) => node.id === "wrap")?.value).toBe(
      "wrap:reviewed:Ada",
    );
  });

  it("recovers blocked downstream steps when their dependency already resolved", async () => {
    const seed = input("seed", z.object({ name: z.string() }));

    const review = atom(
      (get, requestIntervention) => {
        const s = get(seed);
        const approval = requestIntervention(
          "approval",
          z.object({ approved: z.boolean() }),
        );
        if (!approval.approved) return get.skip("review denied");
        return `reviewed:${s.name}`;
      },
      { name: "review" },
    );

    atom(
      (get) => {
        const result = get(review);
        return `wrap:${result}`;
      },
      { name: "wrap" },
    );

    const { scheduler, stateStore } = makeScheduler();
    await scheduler.startRun({
      workflow,
      runId: "run-recover-blocked",
      input: {
        inputId: "seed",
        payload: { name: "Ada" },
        eventId: "evt-seed",
      },
    });

    await scheduler.drain();
    let snapshot = await scheduler.snapshot("run-recover-blocked");
    const interventionId = "review:approval";

    expect(snapshot.status).toBe("waiting");
    expect(snapshot.nodes.find((node) => node.id === "review")?.status).toBe(
      "waiting",
    );
    expect(snapshot.nodes.find((node) => node.id === "wrap")?.status).toBe(
      "blocked",
    );

    const stored = await stateStore.load("run-recover-blocked");
    if (!stored) throw new Error("missing test run");
    const state = structuredClone(stored.state);
    const intervention = state.interventions[interventionId];
    if (!intervention) throw new Error("missing test intervention");
    const previousReview = state.nodes.review;

    state.inputs[interventionId] = { approved: true };
    state.interventions[interventionId] = {
      ...intervention,
      status: "resolved",
      resolvedAt: Date.now(),
    };
    state.nodes.review = {
      status: "resolved",
      kind: previousReview?.kind,
      value: "reviewed:Ada",
      deps: previousReview?.deps ?? [],
      duration_ms: previousReview?.duration_ms ?? 0,
      attempts: (previousReview?.attempts ?? 0) + 1,
    };
    delete state.waiters.review;
    delete state.waiters[interventionId];

    const saved = await stateStore.save(
      "run-recover-blocked",
      state,
      stored.version,
    );
    expect(saved.ok).toBe(true);

    snapshot =
      (await scheduler.recoverReadyWaiters("run-recover-blocked", workflow)) ??
      (await scheduler.snapshot("run-recover-blocked"));

    expect(snapshot.status).toBe("running");
    expect(snapshot.queue.pending).toHaveLength(1);
    expect(snapshot.queue.pending[0]?.event).toMatchObject({
      kind: "step",
      stepId: "wrap",
    });

    await scheduler.drain();
    snapshot = await scheduler.snapshot("run-recover-blocked");

    expect(snapshot.status).toBe("completed");
    expect(snapshot.nodes.find((node) => node.id === "wrap")?.value).toBe(
      "wrap:reviewed:Ada",
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

  it("pauses on an intervention and resumes only its waiting step", async () => {
    const seed = input("seed", z.object({ name: z.string() }));
    let planCalls = 0;

    const plan = atom(
      (get) => {
        const initial = get(seed);
        planCalls++;
        return `plan:${initial.name}`;
      },
      { name: "plan" },
    );

    atom(
      (get, requestIntervention) => {
        const generated = get(plan);
        const review = requestIntervention(
          "review",
          z.object({ approved: z.boolean() }),
          {
            title: "Review generated plan",
            description: `Review ${generated}`,
          },
        );
        if (!review.approved) return get.skip("review denied");
        return `done:${generated}`;
      },
      { name: "finish" },
    );

    const { scheduler, events } = makeScheduler();
    await scheduler.startRun({
      workflow,
      runId: "run-intervention",
      input: {
        inputId: "seed",
        payload: { name: "Ada" },
        eventId: "evt-seed",
      },
    });

    await scheduler.drain();
    let snapshot = await scheduler.snapshot("run-intervention");
    const interventionId = "finish:review";

    expect(snapshot.status).toBe("waiting");
    expect(snapshot.state.interventions[interventionId]).toMatchObject({
      id: interventionId,
      status: "pending",
      title: "Review generated plan",
      description: "Review plan:Ada",
    });
    expect(snapshot.state.waiters[interventionId]).toEqual(["finish"]);

    snapshot = await scheduler.submitIntervention({
      runId: "run-intervention",
      interventionId,
      payload: { approved: true },
    });

    expect(snapshot.status).toBe("running");
    expect(snapshot.state.inputs[interventionId]).toEqual({ approved: true });
    expect(snapshot.queue.pending).toHaveLength(1);
    expect(snapshot.queue.pending[0]?.event.kind).toBe("step");
    expect(
      events.events.some(
        (event) =>
          event.type === "intervention_received" &&
          event.interventionId === interventionId,
      ),
    ).toBe(true);

    await scheduler.drain();
    snapshot = await scheduler.snapshot("run-intervention");
    expect(snapshot.status).toBe("completed");
    expect(snapshot.nodes.find((node) => node.id === "finish")?.value).toBe(
      "done:plan:Ada",
    );
    expect(planCalls).toBe(1);
  });
});
