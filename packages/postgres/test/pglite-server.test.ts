import { PGlite } from "@electric-sql/pglite";
import { atom, globalRegistry, input } from "@workflow/core";
import { createRemoteRuntimeServer } from "@workflow/remote";
import { createWorkflow, type WorkflowRunDocument } from "@workflow/server";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createPostgresWorkflowQueue,
  createPostgresWorkflowStateStore,
} from "../src";

let client: PGlite | undefined;

describe("PGlite Workflow server", () => {
  beforeEach(() => {
    globalRegistry.clear();
  });

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it("starts, drains, stores, and lists a workflow run", async () => {
    const seed = input("seed", z.object({ name: z.string() }));
    const approval = input.deferred(
      "approval",
      z.object({ approved: z.boolean() }),
    );

    const upper = atom(
      (get) => {
        const value = get(seed);
        return value.name.toUpperCase();
      },
      { name: "upper" },
    );

    atom(
      (get) => {
        const name = get(upper);
        const decision = get(approval);
        if (!decision.approved) return get.skip("Approval denied");
        return `approved:${name}`;
      },
      { name: "finish" },
    );

    client = new PGlite();
    const db = drizzle({ client });
    const backend = createRemoteRuntimeServer({
      stateStore: createPostgresWorkflowStateStore(db),
      queue: createPostgresWorkflowQueue(db),
    });
    const app = createWorkflow({
      backendApi: {
        url: "http://backend.test",
        fetch: localFetch(backend),
      },
      workflow: {
        id: "example",
        version: "v1",
      },
    });

    const started = await post<WorkflowRunDocument>(app, "/runs", {
      inputId: "seed",
      payload: { name: "ada" },
    });

    expect(started.status).toBe("waiting");
    expect(started.nodes.find((node) => node.id === "upper")?.value).toBe(
      "ADA",
    );
    expect(started.nodes.find((node) => node.id === "finish")?.status).toBe(
      "waiting",
    );

    const finished = await post<WorkflowRunDocument>(
      app,
      `/runs/${started.runId}/inputs`,
      {
        inputId: "approval",
        payload: { approved: true },
      },
    );

    expect(finished.status).toBe("completed");
    expect(finished.nodes.find((node) => node.id === "finish")?.value).toBe(
      "approved:ADA",
    );

    const fetched = await get<WorkflowRunDocument>(
      app,
      `/runs/${started.runId}`,
    );
    expect(fetched.runId).toBe(started.runId);
    expect(fetched.events.some((event) => event.type === "run_completed")).toBe(
      true,
    );

    const runs = await get<{ runId: string; status: string }[]>(app, "/runs");
    expect(runs).toEqual([
      expect.objectContaining({
        runId: started.runId,
        status: "completed",
      }),
    ]);
  });

  it("persists user-scoped atom values through the remote backend", async () => {
    const seed = input("seed", z.object({ name: z.string() }));
    let calls = 0;

    atom(
      (get) => {
        const value = get(seed);
        calls += 1;
        return `${value.name}:${calls}`;
      },
      { name: "cached", persistence: "user" },
    );

    client = new PGlite();
    const db = drizzle({ client });
    const backend = createRemoteRuntimeServer({
      stateStore: createPostgresWorkflowStateStore(db),
      queue: createPostgresWorkflowQueue(db),
    });
    const app = createWorkflow({
      backendApi: {
        url: "http://backend.test",
        fetch: localFetch(backend),
      },
      workflow: {
        id: "example",
        version: "v1",
        organizationId: "org_1",
        userId: "user_1",
      },
    });

    const first = await post<WorkflowRunDocument>(app, "/runs", {
      inputId: "seed",
      payload: { name: "ada" },
    });
    const second = await post<WorkflowRunDocument>(app, "/runs", {
      inputId: "seed",
      payload: { name: "ada" },
    });

    expect(first.nodes.find((node) => node.id === "cached")?.value).toBe(
      "ada:1",
    );
    expect(second.nodes.find((node) => node.id === "cached")?.value).toBe(
      "ada:1",
    );
    expect(calls).toBe(1);
  });
});

async function post<T>(
  app: ReturnType<typeof createWorkflow>,
  path: string,
  body: unknown,
): Promise<T> {
  const response = await app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<T>;
}

function localFetch(app: {
  fetch(request: Request): Response | Promise<Response>;
}): typeof fetch {
  return (input, init) => app.fetch(new Request(input, init));
}

async function get<T>(
  app: ReturnType<typeof createWorkflow>,
  path: string,
): Promise<T> {
  const response = await app.request(path);
  expect(response.status).toBe(200);
  return response.json() as Promise<T>;
}
