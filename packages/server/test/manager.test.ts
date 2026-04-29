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
    expect(started.queue.pending).toHaveLength(0);
    expect(started.queue.running).toHaveLength(1);
    expect(started.queue.running[0]?.event.kind).toBe("input");

    const afterInput = await manager.advanceRun(started.runId);

    expect(afterInput.status).toBe("running");
    expect(afterInput.queue.pending).toHaveLength(0);
    expect(afterInput.queue.running).toHaveLength(1);
    expect(afterInput.queue.running[0]?.event.kind).toBe("step");
    expect(
      afterInput.nodes.find((node) => node.id === "increment")?.status,
    ).toBe("running");

    const reloaded = await manager.getRun(started.runId);
    expect(reloaded?.queue.running[0]?.event.kind).toBe("step");
    expect(
      reloaded?.nodes.find((node) => node.id === "increment")?.status,
    ).toBe("running");

    const completed = await manager.advanceRun(started.runId);

    expect(completed.status).toBe("completed");
    expect(completed.queue.pending).toHaveLength(0);
    expect(
      completed.nodes.find((node) => node.id === "increment")?.status,
    ).toBe("resolved");
  });

  it("starts blank runs and resolves atoms that do not need an input", async () => {
    const seed = input("seed", z.object({ value: z.number() }));
    atom(() => "ready", { name: "standalone" });
    atom(
      (get) => {
        const payload = get(seed);
        return payload.value + 1;
      },
      { name: "needsSeed" },
    );

    const manager = new WorkflowManager({
      stateStore: new TestWorkflowStateStore(),
      queue: new TestWorkflowQueue(),
    });

    const started = await manager.startRun({});

    expect(started.status).toBe("running");
    expect(started.queue.running.map((item) => item.event.kind)).toEqual([
      "step",
    ]);
    expect(started.queue.pending.map((item) => item.event.kind)).toEqual([
      "step",
    ]);

    const completed = await manager.advanceUntilSettled(started.runId);

    expect(completed.status).toBe("completed");
    expect(
      completed.nodes.find((node) => node.id === "standalone")?.status,
    ).toBe("resolved");
    expect(completed.state.nodes.standalone?.value).toBe("ready");
    expect(
      completed.nodes.find((node) => node.id === "needsSeed")?.status,
    ).toBe("skipped");
    expect(completed.state.trigger).toBeUndefined();
  });

  it("presents next pending work as running even when a queue item is already running", async () => {
    const stateStore = new TestWorkflowStateStore();
    const manager = new WorkflowManager({
      stateStore,
      queue: new TestWorkflowQueue(),
    });

    await stateStore.saveRunDocument({
      runId: "run_running_and_pending",
      workflow: manager.definition.ref,
      status: "running",
      nodes: [
        {
          id: "claimed",
          kind: "atom",
          status: "queued",
          deps: [],
          attempts: 0,
        },
        {
          id: "nextUp",
          kind: "atom",
          status: "queued",
          deps: [],
          attempts: 0,
        },
      ],
      edges: [],
      queue: {
        pending: [
          {
            event: {
              kind: "step",
              eventId: "event_next",
              runId: "run_running_and_pending",
              stepId: "nextUp",
            },
            status: "pending",
            enqueuedAt: 2,
          },
        ],
        running: [
          {
            event: {
              kind: "step",
              eventId: "event_claimed",
              runId: "run_running_and_pending",
              stepId: "claimed",
            },
            status: "running",
            enqueuedAt: 1,
            startedAt: 1,
          },
        ],
        completed: [],
        failed: [],
      },
      state: {
        runId: "run_running_and_pending",
        startedAt: 1,
        inputs: {},
        interventions: {},
        nodes: {},
        waiters: {},
        processedEventIds: {},
      },
      version: 1,
      events: [],
      publishedAt: 1,
    });

    const run = await manager.getRun("run_running_and_pending");

    expect(run?.queue.pending).toHaveLength(0);
    expect(run?.queue.running.map((item) => item.event.eventId)).toEqual([
      "event_next",
      "event_claimed",
    ]);
    expect(run?.nodes.map((node) => [node.id, node.status])).toEqual([
      ["claimed", "running"],
      ["nextUp", "running"],
    ]);
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
    expect(
      [...started.queue.running, ...started.queue.pending]
        .filter((item) => item.event.kind === "input")
        .map((item) => item.event.inputId),
    ).toEqual(["leadA", "leadB"]);
  });

  it("includes managed connections in the manifest", () => {
    atom(() => ({ accessToken: "token" }), {
      name: "notionConnection",
      description: "Authorize Notion before creating a page.",
      managedConnection: {
        kind: "oauth",
        providerId: "notion",
        requirement: "preflight",
        title: "Notion",
        scopes: ["pages:write"],
      },
    });

    const manager = new WorkflowManager({
      stateStore: new TestWorkflowStateStore(),
      queue: new TestWorkflowQueue(),
    });

    expect(manager.manifest().managedConnections).toEqual([
      {
        id: "notionConnection",
        kind: "oauth",
        providerId: "notion",
        requirement: "preflight",
        title: "Notion",
        description: "Authorize Notion before creating a page.",
        scopes: ["pages:write"],
      },
    ]);
  });

  it("binds preflight managed connections to the worker configuration run", async () => {
    const seed = input("seed", z.object({ slug: z.string() }));
    const notionConnection = atom(
      (_get, requestIntervention) =>
        requestIntervention(
          "oauth-callback",
          z.object({ accessToken: z.string() }),
          {
            title: "Connect Notion",
            action: {
              type: "open_url",
              url: "https://example.com/notion",
              label: "Connect Notion",
            },
          },
        ),
      {
        name: "notionConnection",
        managedConnection: {
          kind: "oauth",
          providerId: "notion",
          requirement: "preflight",
          title: "Notion",
        },
      },
    );
    atom(
      (get) => {
        get(seed);
        return get(notionConnection).accessToken;
      },
      { name: "publishToNotion" },
    );

    const manager = new WorkflowManager({
      stateStore: new TestWorkflowStateStore(),
      queue: new TestWorkflowQueue(),
    });

    await expect(
      manager.startRun({
        inputId: "seed",
        payload: { slug: "hello" },
      }),
    ).rejects.toThrow(/Worker configuration incomplete/);

    const connecting =
      await manager.connectManagedConnection("notionConnection");
    expect(connecting.ready).toBe(false);
    expect(connecting.runId).toBe("@configuration/workflow");
    expect(connecting.connections).toEqual([
      expect.objectContaining({
        id: "notionConnection",
        status: "connecting",
      }),
    ]);
    expect(
      connecting.run?.state.interventions["notionConnection:oauth-callback"],
    ).toMatchObject({
      id: "notionConnection:oauth-callback",
      status: "pending",
      title: "Connect Notion",
    });

    await manager.submitIntervention(
      connecting.runId,
      "notionConnection:oauth-callback",
      {
        payload: { accessToken: "token_123" },
      },
    );

    const configuration = await manager.configuration();
    expect(configuration.ready).toBe(true);
    expect(configuration.connections).toEqual([
      expect.objectContaining({
        id: "notionConnection",
        status: "connected",
      }),
    ]);

    const started = await manager.startRun({
      inputId: "seed",
      payload: { slug: "hello" },
    });
    let completed = started;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      completed = await manager.advanceRun(started.runId);
      if (completed.status === "completed") break;
    }

    expect(completed.status).toBe("completed");
    expect(completed.state.nodes.notionConnection?.value).toEqual({
      accessToken: "token_123",
    });
    expect((await manager.listRuns()).map((run) => run.runId)).toEqual([
      started.runId,
    ]);
  });

  it("restarts a pending managed connection with a fresh oauth intervention", async () => {
    let authorizeVersion = 0;
    atom(
      (_get, requestIntervention) => {
        authorizeVersion += 1;
        return requestIntervention(
          "oauth-callback",
          z.object({ accessToken: z.string() }),
          {
            title: "Connect Notion",
            action: {
              type: "open_url",
              url: `https://example.com/notion?v=${authorizeVersion}`,
              label: "Connect Notion",
            },
          },
        );
      },
      {
        name: "notionConnection",
        managedConnection: {
          kind: "oauth",
          providerId: "notion",
          requirement: "preflight",
          title: "Notion",
        },
      },
    );

    const manager = new WorkflowManager({
      stateStore: new TestWorkflowStateStore(),
      queue: new TestWorkflowQueue(),
    });

    const initial = await manager.connectManagedConnection("notionConnection");
    expect(
      initial.run?.state.interventions["notionConnection:oauth-callback"]
        ?.action?.url,
    ).toBe("https://example.com/notion?v=1");

    const restarted = await manager.connectManagedConnection(
      "notionConnection",
      {
        restart: true,
      },
    );
    expect(
      restarted.run?.state.interventions["notionConnection:oauth-callback"]
        ?.action?.url,
    ).toBe("https://example.com/notion?v=2");
    expect(restarted.run?.state.nodes.notionConnection?.status).toBe("waiting");
  });

  it("clears an existing managed connection", async () => {
    atom(
      (_get, requestIntervention) =>
        requestIntervention(
          "oauth-callback",
          z.object({ accessToken: z.string() }),
          {
            title: "Connect Notion",
            action: {
              type: "open_url",
              url: "https://example.com/notion",
              label: "Connect Notion",
            },
          },
        ),
      {
        name: "notionConnection",
        managedConnection: {
          kind: "oauth",
          providerId: "notion",
          requirement: "preflight",
          title: "Notion",
        },
      },
    );

    const manager = new WorkflowManager({
      stateStore: new TestWorkflowStateStore(),
      queue: new TestWorkflowQueue(),
    });

    const connecting =
      await manager.connectManagedConnection("notionConnection");
    await manager.submitIntervention(
      connecting.runId,
      "notionConnection:oauth-callback",
      {
        payload: { accessToken: "token_123" },
      },
    );

    const cleared = await manager.clearManagedConnection("notionConnection");
    expect(cleared.ready).toBe(false);
    expect(cleared.connections).toEqual([
      expect.objectContaining({
        id: "notionConnection",
        status: "not_connected",
      }),
    ]);
    expect(cleared.run?.state.nodes.notionConnection).toBeUndefined();
    expect(
      cleared.run?.state.interventions?.["notionConnection:oauth-callback"],
    ).toBeUndefined();
  });

  it("reauths one managed connection without regressing another", async () => {
    const notion = atom(
      (_get, requestIntervention) =>
        requestIntervention(
          "oauth-callback",
          z.object({ accessToken: z.string() }),
          {
            title: "Connect Notion",
            action: {
              type: "open_url",
              url: "https://example.com/notion",
              label: "Connect Notion",
            },
          },
        ),
      {
        name: "notionConnection",
        managedConnection: {
          kind: "oauth",
          providerId: "notion",
          requirement: "preflight",
          title: "Notion",
        },
      },
    );
    const slack = atom(
      (_get, requestIntervention) =>
        requestIntervention(
          "oauth-callback",
          z.object({ accessToken: z.string() }),
          {
            title: "Connect Slack",
            action: {
              type: "open_url",
              url: "https://example.com/slack",
              label: "Connect Slack",
            },
          },
        ),
      {
        name: "slackConnection",
        managedConnection: {
          kind: "oauth",
          providerId: "slack",
          requirement: "preflight",
          title: "Slack",
        },
      },
    );
    atom((get) => get(notion).accessToken, { name: "usesNotion" });
    atom((get) => get(slack).accessToken, { name: "usesSlack" });

    const manager = new WorkflowManager({
      stateStore: new TestWorkflowStateStore(),
      queue: new TestWorkflowQueue(),
    });

    const notionConnecting =
      await manager.connectManagedConnection("notionConnection");
    await manager.submitIntervention(
      notionConnecting.runId,
      "notionConnection:oauth-callback",
      {
        payload: { accessToken: "notion_1" },
      },
    );

    const slackConnecting =
      await manager.connectManagedConnection("slackConnection");
    await manager.submitIntervention(
      slackConnecting.runId,
      "slackConnection:oauth-callback",
      {
        payload: { accessToken: "slack_1" },
      },
    );

    const restarted = await manager.connectManagedConnection(
      "notionConnection",
      {
        restart: true,
      },
    );
    expect(restarted.connections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "notionConnection",
          status: "connecting",
        }),
        expect.objectContaining({
          id: "slackConnection",
          status: "connected",
        }),
      ]),
    );

    await manager.submitIntervention(
      restarted.runId,
      "notionConnection:oauth-callback",
      {
        payload: { accessToken: "notion_2" },
      },
    );

    const configuration = await manager.configuration();
    expect(configuration.ready).toBe(true);
    expect(configuration.connections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "notionConnection",
          status: "connected",
        }),
        expect.objectContaining({
          id: "slackConnection",
          status: "connected",
        }),
      ]),
    );
    expect(configuration.run?.state.nodes.notionConnection?.status).toBe(
      "resolved",
    );
    expect(configuration.run?.state.nodes.slackConnection?.status).toBe(
      "resolved",
    );
  });

  describe("tickSchedules", () => {
    it("starts a run for each schedule whose cron matches", async () => {
      const sweep = input("sweep", z.object({ region: z.string() }));
      const { schedule } = await import("@workflow/core");
      schedule("sweep-us", "*/15 * * * *", {
        trigger: sweep,
        payload: { region: "us-east-1" },
      });
      schedule("sweep-eu", "0 3 * * *", {
        trigger: sweep,
        payload: { region: "eu-west-1" },
      });

      const manager = new WorkflowManager({
        stateStore: new TestWorkflowStateStore(),
        queue: new TestWorkflowQueue(),
      });

      const result = await manager.tickSchedules(
        new Date("2026-04-27T15:15:00Z"),
      );

      expect(result.fired.map((f) => f.id)).toEqual(["sweep-us"]);
      expect(result.skipped).toEqual([]);
      expect(result.fired[0]?.runId).toMatch(/^run_/);
    });

    it("fires multiple schedules at the same minute", async () => {
      const a = input("a", z.object({}));
      const b = input("b", z.object({}));
      const { schedule } = await import("@workflow/core");
      schedule("a-tick", "* * * * *", { trigger: a, payload: {} });
      schedule("b-tick", "* * * * *", { trigger: b, payload: {} });

      const manager = new WorkflowManager({
        stateStore: new TestWorkflowStateStore(),
        queue: new TestWorkflowQueue(),
      });

      const result = await manager.tickSchedules(
        new Date("2026-04-27T15:00:00Z"),
      );

      expect(result.fired.map((f) => f.id).sort()).toEqual([
        "a-tick",
        "b-tick",
      ]);
    });

    it("returns empty when no schedules match", async () => {
      const t = input("t", z.object({}));
      const { schedule } = await import("@workflow/core");
      schedule("hourly", "0 * * * *", { trigger: t, payload: {} });

      const manager = new WorkflowManager({
        stateStore: new TestWorkflowStateStore(),
        queue: new TestWorkflowQueue(),
      });

      const result = await manager.tickSchedules(
        new Date("2026-04-27T15:30:00Z"),
      );
      expect(result.fired).toEqual([]);
      expect(result.skipped).toEqual([]);
    });
  });

  describe("runScheduleNow", () => {
    it("starts a run using the schedule's captured payload, ignoring cron", async () => {
      const trigger = input("nightly", z.object({ region: z.string() }));
      const { schedule } = await import("@workflow/core");
      schedule("us-nightly", "0 3 * * *", {
        trigger,
        payload: { region: "us-east-1" },
      });

      const manager = new WorkflowManager({
        stateStore: new TestWorkflowStateStore(),
        queue: new TestWorkflowQueue(),
      });

      // Way outside the 03:00 cron window — runScheduleNow ignores cron.
      const run = await manager.runScheduleNow("us-nightly");
      expect(run.runId).toMatch(/^run_/);
      expect(run.queue.running[0]?.event.kind).toBe("input");
    });

    it("rejects unknown schedule ids", async () => {
      const manager = new WorkflowManager({
        stateStore: new TestWorkflowStateStore(),
        queue: new TestWorkflowQueue(),
      });
      await expect(manager.runScheduleNow("ghost")).rejects.toThrow(
        /Unknown schedule: ghost/,
      );
    });
  });

  describe("advanceUntilSettled", () => {
    it("drives a run from running to its natural park point at waiting", async () => {
      const trigger = input("trig", z.object({ ok: z.boolean() }));
      const deferred = input.deferred(
        "investigation",
        z.object({ ok: z.boolean() }),
      );
      atom(
        (get) => {
          get(trigger);
          return get(deferred);
        },
        { name: "report" },
      );

      const manager = new WorkflowManager({
        stateStore: new TestWorkflowStateStore(),
        queue: new TestWorkflowQueue(),
      });

      const started = await manager.startRun({
        inputId: "trig",
        payload: { ok: true },
      });
      expect(started.status).toBe("running");

      const settled = await manager.advanceUntilSettled(started.runId);
      expect(settled.status).toBe("waiting");
      expect(settled.nodes.find((n) => n.id === "report")?.status).toBe(
        "waiting",
      );
    });

    it("drains a webhook-resumed run through to completion", async () => {
      const trigger2 = input("trig2", z.object({ ok: z.boolean() }));
      const deferred2 = input.deferred(
        "investigation2",
        z.object({ ok: z.boolean() }),
      );
      atom(
        (get) => {
          const t = get(trigger2);
          const d = get(deferred2);
          return { trig: t.ok, def: d.ok };
        },
        { name: "report2" },
      );

      const manager = new WorkflowManager({
        stateStore: new TestWorkflowStateStore(),
        queue: new TestWorkflowQueue(),
      });

      const started = await manager.startRun({
        inputId: "trig2",
        payload: { ok: true },
      });
      const parked = await manager.advanceUntilSettled(started.runId);
      expect(parked.status).toBe("waiting");

      await manager.submitWebhook({
        runId: started.runId,
        payload: { ok: true },
      });
      const completed = await manager.advanceUntilSettled(started.runId);

      expect(completed.status).toBe("completed");
      expect(completed.nodes.find((n) => n.id === "report2")?.status).toBe(
        "resolved",
      );
    });

    it("returns immediately when the run is already settled", async () => {
      input("once", z.object({}));

      const manager = new WorkflowManager({
        stateStore: new TestWorkflowStateStore(),
        queue: new TestWorkflowQueue(),
      });

      const started = await manager.startRun({
        inputId: "once",
        payload: {},
      });
      const settled = await manager.advanceUntilSettled(started.runId);
      // Then call it again — should be a no-op.
      const again = await manager.advanceUntilSettled(started.runId);
      expect(settled.status).toBe(again.status);
      expect(again.status).toBe("completed");
    });

    it("recovers a queue item left in 'running' after lease expiry", async () => {
      // Models the production failure: a worker dequeued a queue item, the
      // wall-clock killed it before processNext finished, and the row was
      // never moved out of 'running'. claimNext must reconsider expired-
      // lease running rows so the run isn't stuck forever.
      const trigger = input("trigRecover", z.object({ ok: z.boolean() }));
      atom((get) => get(trigger), { name: "after" });

      const queue = new TestWorkflowQueue({ leaseMs: 30_000 });
      const manager = new WorkflowManager({
        stateStore: new TestWorkflowStateStore(),
        queue,
      });

      const started = await manager.startRun({
        inputId: "trigRecover",
        payload: { ok: true },
      });

      // Drain one step — claims and 'processes' the input event. We then
      // force the lease to expire to simulate a worker that died after
      // claiming but before completing.
      const claimed = await queue.claimNext(started.runId);
      if (!claimed) throw new Error("expected to claim the input event");
      expect(claimed.event.runId).toBe(started.runId);
      queue.expireLease(claimed.event.eventId);
      // Item is now in 'running' status with an expired lease — the bug case.
      const stuck = await queue.snapshot(started.runId);
      expect(stuck.running.length).toBe(1);
      expect(stuck.pending.length).toBe(0);

      // Recovery: a fresh claim must pick it up again.
      const reclaimed = await queue.claimNext(started.runId);
      expect(reclaimed?.event.eventId).toBe(claimed.event.eventId);
      expect(reclaimed?.status).toBe("running");
    });
  });

  describe("pumpInProgressRuns", () => {
    it("advances every run still in 'running'", async () => {
      // The cron heartbeat needs to walk all live runs and push them
      // forward, not just the ones that just fired. Two runs start, one
      // is fully drained inline, the other is left running with pending
      // work — pumpInProgressRuns must drive the second one to its
      // settled state without anyone calling /advance on it directly.
      const trigger = input("trigPump", z.object({ value: z.number() }));
      atom((get) => get(trigger).value + 1, { name: "incrPump" });

      const manager = new WorkflowManager({
        stateStore: new TestWorkflowStateStore(),
        queue: new TestWorkflowQueue(),
      });

      const drained = await manager.startRun({
        inputId: "trigPump",
        payload: { value: 1 },
      });
      const settled = await manager.advanceUntilSettled(drained.runId);
      expect(settled.status).toBe("completed");

      const stillRunning = await manager.startRun({
        inputId: "trigPump",
        payload: { value: 2 },
      });
      // Intentionally do not call advanceUntilSettled — leave it in 'running'.
      expect(stillRunning.status).toBe("running");

      const result = await manager.pumpInProgressRuns();
      expect(result.attempted).toBe(1);
      expect(result.pumped).toHaveLength(1);
      const entry = result.pumped[0];
      if (entry?.outcome !== "advanced") {
        throw new Error(`expected advanced, got ${entry?.outcome}`);
      }
      expect(entry.runId).toBe(stillRunning.runId);
      expect(entry.status).toBe("completed");
    });

    it("respects the wall-clock budget and defers remaining runs", async () => {
      input("trigBudget", z.object({}));
      atom(() => 1, { name: "incrBudget" });

      const manager = new WorkflowManager({
        stateStore: new TestWorkflowStateStore(),
        queue: new TestWorkflowQueue(),
      });

      const a = await manager.startRun({
        inputId: "trigBudget",
        payload: {},
      });
      const b = await manager.startRun({
        inputId: "trigBudget",
        payload: {},
      });
      expect(a.runId).not.toBe(b.runId);

      // budgetMs=0 means the deadline is already past on the first
      // iteration — every run should be reported as skipped_budget.
      const result = await manager.pumpInProgressRuns({ budgetMs: 0 });
      expect(result.attempted).toBe(2);
      expect(
        result.pumped.every((entry) => entry.outcome === "skipped_budget"),
      ).toBe(true);
    });
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
  private readonly items: (QueueItem & { leaseUntilAt?: number })[] = [];
  private readonly leaseMs: number;

  constructor(opts: { leaseMs?: number } = {}) {
    this.leaseMs = opts.leaseMs ?? 30_000;
  }

  // Test-only: force a claimed item's lease to expire so claimNext can
  // exercise the recovery path without sleeping.
  expireLease(eventId: string): void {
    const item = this.items.find(
      (candidate) => candidate.event.eventId === eventId,
    );
    if (item) item.leaseUntilAt = 0;
  }

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
    const now = Date.now();
    const item = this.items.find(
      (candidate) =>
        candidate.event.runId === runId &&
        (candidate.status === "pending" ||
          (candidate.status === "running" &&
            candidate.leaseUntilAt !== undefined &&
            candidate.leaseUntilAt < now)),
    );
    if (!item) return undefined;
    item.status = "running";
    item.startedAt = now;
    item.leaseUntilAt = now + this.leaseMs;
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
