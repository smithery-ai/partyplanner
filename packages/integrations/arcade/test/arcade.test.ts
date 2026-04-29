import { atom, createRuntime, globalRegistry, input } from "@workflow/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createArcadeHandoffRoutes, createArcadeToolAtom } from "../src";

async function runToIdle(
  seed: Parameters<ReturnType<typeof createRuntime>["process"]>[0],
  state?: Awaited<
    ReturnType<ReturnType<typeof createRuntime>["process"]>
  >["state"],
) {
  const runtime = createRuntime();
  const queue = [seed];
  let currentState:
    | Awaited<ReturnType<ReturnType<typeof createRuntime>["process"]>>["state"]
    | undefined = state;
  let trace:
    | Awaited<ReturnType<ReturnType<typeof createRuntime>["process"]>>["trace"]
    | undefined;

  while (queue.length > 0) {
    const event = queue.shift();
    if (!event) break;
    const result = await runtime.process(event, currentState);
    currentState = result.state;
    trace = result.trace;
    queue.push(...result.emitted);
  }

  if (!currentState || !trace) {
    throw new Error("Queue did not produce a run state");
  }
  return { state: currentState, trace };
}

describe("Arcade authorization handoff", () => {
  beforeEach(() => {
    globalRegistry.clear();
    vi.restoreAllMocks();
  });

  it("passes a Hylo handoff URL as Arcade next_uri", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url) => {
        if (String(url) === "https://backend.test/arcade/v1/tools/authorize") {
          return new Response(
            JSON.stringify({
              id: "auth_1",
              status: "pending",
              url: "https://arcade.test/authorize",
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        return new Response("not found", { status: 404 });
      });

    const seed = input("seed", z.object({ ok: z.boolean() }));
    const auth = atom(
      () => ({
        apiKey: "hylo-app-token",
        baseUrl: "https://backend.test/arcade",
      }),
      { name: "arcadeAuth" },
    );
    const appBaseUrl = atom(() => "https://worker.test/deployment", {
      name: "appBaseUrl",
    });

    const projects = createArcadeToolAtom({
      toolName: "Linear.GetProjects",
      input: {},
      inputSchema: z.object({}),
      outputSchema: z.unknown(),
      opts: {
        actionName: "linearProjects",
        appBaseUrl,
        auth,
        userId: "ani@example.com",
      },
    });
    atom((get) => get(projects), { name: "result" });
    atom((get) => get(seed), { name: "seedPassThrough" });

    const run = await runToIdle({
      kind: "input",
      eventId: "evt-seed",
      runId: "run-arcade",
      inputId: "seed",
      payload: { ok: true },
    });

    const interventionId =
      "linearProjects:arcade-linear-getprojects-authorization";
    expect(run.trace.nodes.linearProjects?.status).toBe("waiting");
    expect(run.trace.nodes.linearProjects?.waitingOn).toBe(interventionId);

    const authorizeBody = JSON.parse(
      String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}"),
    );
    const nextUri = new URL(authorizeBody.next_uri);
    expect(`${nextUri.origin}${nextUri.pathname}`).toBe(
      "https://worker.test/deployment/api/workflow/integrations/arcade/handoff",
    );
    expect(nextUri.searchParams.get("runId")).toBe("run-arcade");
    expect(nextUri.searchParams.get("interventionId")).toBe(interventionId);
  });

  it("resolves the Arcade intervention when the handoff route is hit", async () => {
    const requests: unknown[] = [];
    const routes = createArcadeHandoffRoutes({
      workflowBasePath: "/api/workflow",
      workflowApp: {
        async fetch(request) {
          requests.push({
            body: await request.json(),
            method: request.method,
            url: request.url,
          });
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      },
    });

    const response = await routes.request(
      "https://worker.test/handoff?runId=run-1&interventionId=linearProjects%3Aarcade-linear-getprojects-authorization",
    );

    expect(response.status).toBe(200);
    expect(requests).toEqual([
      {
        body: { payload: { ok: true } },
        method: "POST",
        url: "https://worker.test/api/workflow/runs/run-1/interventions/linearProjects%3Aarcade-linear-getprojects-authorization",
      },
    ]);
  });
});
