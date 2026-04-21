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

  it("reuses user-persisted atom values across runs when dependencies match", async () => {
    const seed = input("seed", z.object({ name: z.string() }));
    let calls = 0;

    atom(
      (get) => {
        const value = get(seed);
        calls += 1;
        return `${value.name}:${calls}`;
      },
      { name: "userCached", persistence: "user" },
    );

    const stateStore = new MemoryStateStore();
    const scheduler = new LocalScheduler({
      loader: new StaticWorkflowLoader([
        {
          ref: { ...workflow, userId: "user_1" },
          registry: globalRegistry,
        },
      ]),
      stateStore,
      queue: new MemoryWorkQueue(),
      events: new MemoryEventSink(),
      executor: new RuntimeExecutor({ atomValueStore: stateStore }),
    });

    await scheduler.startRun({
      workflow: { ...workflow, userId: "user_1" },
      runId: "run-user-cache-1",
      input: {
        inputId: "seed",
        payload: { name: "Ada" },
        eventId: "evt-seed-1",
      },
    });
    await scheduler.drain();
    const first = await scheduler.snapshot("run-user-cache-1");
    expect(first.nodes.find((node) => node.id === "userCached")?.value).toBe(
      "Ada:1",
    );

    await scheduler.startRun({
      workflow: { ...workflow, userId: "user_1" },
      runId: "run-user-cache-2",
      input: {
        inputId: "seed",
        payload: { name: "Ada" },
        eventId: "evt-seed-2",
      },
    });
    await scheduler.drain();
    const second = await scheduler.snapshot("run-user-cache-2");

    expect(second.nodes.find((node) => node.id === "userCached")?.value).toBe(
      "Ada:1",
    );
    expect(calls).toBe(1);
  });

  it("scopes organization-persisted atom values by organization", async () => {
    const seed = input("seed", z.object({ name: z.string() }));
    let calls = 0;

    atom(
      (get) => {
        const value = get(seed);
        calls += 1;
        return `${value.name}:${calls}`;
      },
      { name: "orgCached", persistence: "organization" },
    );

    const stateStore = new MemoryStateStore();
    const scheduler = new LocalScheduler({
      loader: new StaticWorkflowLoader([
        {
          ref: { ...workflow, organizationId: "org_1", userId: "user_1" },
          registry: globalRegistry,
        },
      ]),
      stateStore,
      queue: new MemoryWorkQueue(),
      events: new MemoryEventSink(),
      executor: new RuntimeExecutor({ atomValueStore: stateStore }),
    });

    for (const [runId, organizationId, userId] of [
      ["run-org-cache-1", "org_1", "user_1"],
      ["run-org-cache-2", "org_1", "user_2"],
      ["run-org-cache-3", "org_2", "user_1"],
    ] as const) {
      await scheduler.startRun({
        workflow: { ...workflow, organizationId, userId },
        runId,
        input: {
          inputId: "seed",
          payload: { name: "Ada" },
          eventId: `evt-${runId}`,
        },
      });
      await scheduler.drain();
    }

    expect(
      (await scheduler.snapshot("run-org-cache-1")).nodes.find(
        (node) => node.id === "orgCached",
      )?.value,
    ).toBe("Ada:1");
    expect(
      (await scheduler.snapshot("run-org-cache-2")).nodes.find(
        (node) => node.id === "orgCached",
      )?.value,
    ).toBe("Ada:1");
    expect(
      (await scheduler.snapshot("run-org-cache-3")).nodes.find(
        (node) => node.id === "orgCached",
      )?.value,
    ).toBe("Ada:2");
    expect(calls).toBe(2);
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
