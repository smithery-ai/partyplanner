import { atom, createRuntime, globalRegistry, input } from "@workflow/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { postMessage } from "../src/actions";

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

  if (!currentState || !trace)
    throw new Error("Queue did not produce a run state");
  return { state: currentState, trace };
}

describe("postMessage", () => {
  beforeEach(() => {
    globalRegistry.clear();
    vi.restoreAllMocks();
  });

  it("posts a Slack message with the bot token", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          channel: "C123",
          ts: "1740000000.000100",
          message: { text: "Hello from Hylo" },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const seed = input("seed", z.object({ ok: z.boolean().default(true) }));
    const auth = atom(
      () => ({
        accessToken: "xoxb-test",
        tokenType: "bot",
        scopes: ["chat:write"],
      }),
      { name: "slackAuth" },
    );
    const channel = atom(() => "C123", { name: "channel" });
    const text = atom(() => "Hello from Hylo", { name: "text" });

    atom((get) => get(seed), { name: "seedPassThrough" });
    const sendSlackMessage = postMessage({
      auth,
      channel,
      text,
      actionName: "sendSlackMessage",
    });
    atom((get) => get(sendSlackMessage), {
      name: "sendSlackMessageResult",
    });

    const waiting = await runToIdle({
      kind: "input",
      eventId: "evt-seed",
      runId: "run-slack",
      inputId: "seed",
      payload: { ok: true },
    });

    expect(waiting.trace.nodes.sendSlackMessage?.status).toBe("resolved");
    expect(waiting.trace.nodes.sendSlackMessage?.value).toEqual({
      channel: "C123",
      channelId: "C123",
      ts: "1740000000.000100",
      text: "Hello from Hylo",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://slack.com/api/chat.postMessage",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer xoxb-test",
          "Content-Type": "application/json",
        }),
      }),
    );
  });
});
