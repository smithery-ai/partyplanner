import { atom, createRuntime, globalRegistry, input } from "@workflow/core";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { getPage } from "../src/atoms";

async function runToIdle(seed: {
  kind: "input";
  eventId: string;
  runId: string;
  inputId: string;
  payload: unknown;
}) {
  const runtime = createRuntime();
  const queue = [seed];
  let state = undefined;
  let trace = undefined;

  while (queue.length > 0) {
    const event = queue.shift();
    if (!event) break;
    const result = await runtime.process(event, state);
    state = result.state;
    trace = result.trace;
    queue.push(...result.emitted);
  }

  if (!state || !trace) throw new Error("Queue did not produce a run state");
  return { state, trace };
}

describe("getPage", () => {
  beforeEach(() => globalRegistry.clear());

  it("skips before requesting auth when the page input was not submitted", async () => {
    const seed = input("seed", z.object({ ok: z.boolean().default(true) }));
    const request = input(
      "request",
      z.object({
        pageId: z.string().default(""),
      }),
    );
    const pageId = atom((get) => get(request).pageId, {
      name: "pageId",
    });
    const auth = input.deferred(
      "notionAuth",
      z.object({
        accessToken: z.string(),
        workspaceId: z.string().optional(),
        workspaceName: z.string().optional(),
        workspaceIcon: z.string().optional(),
        botId: z.string().optional(),
      }),
    );

    atom((get) => get(seed), { name: "seedPassThrough" });
    getPage({
      auth,
      pageId,
      name: "notionFetchedPage",
    });

    const result = await runToIdle({
      kind: "input",
      eventId: "evt-seed",
      runId: "run-skip-auth",
      inputId: "seed",
      payload: { ok: true },
    });

    expect(result.trace.nodes.pageId?.status).toBe("skipped");
    expect(result.trace.nodes.notionFetchedPage?.status).toBe("skipped");
    expect(result.state.interventions).toEqual({});
    expect(result.state.waiters.notionAuth).toBeUndefined();
  });
});
