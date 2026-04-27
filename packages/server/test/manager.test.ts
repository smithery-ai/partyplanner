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
    expect(
      started.queue.pending
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
      expect(run.queue.pending[0]?.event.kind).toBe("input");
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
