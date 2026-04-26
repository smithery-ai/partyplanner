import { atom, createRuntime, globalRegistry, input } from "@workflow/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  getChannelMessages,
  getThreadMessages,
  messageFromWebhook,
} from "../src/atoms";
import { slackWebhookPayloadSchema } from "../src/webhooks";

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

describe("Slack atoms", () => {
  beforeEach(() => {
    globalRegistry.clear();
    vi.restoreAllMocks();
  });

  it("extracts a Slack message from the managed webhook payload", async () => {
    const webhook = input("slackWebhook", slackWebhookPayloadSchema);
    const received = messageFromWebhook({
      webhook,
      name: "receivedSlackMessage",
    });
    atom((get) => get(received), { name: "receivedSlackMessageResult" });

    const result = await runToIdle({
      kind: "input",
      eventId: "evt-slack",
      runId: "run-slack",
      inputId: "slackWebhook",
      payload: {
        source: "slack",
        kind: "event_callback",
        teamId: "T123",
        appId: "A123",
        payload: {
          type: "event_callback",
          event: {
            type: "app_mention",
            user: "U123",
            channel: "C123",
            ts: "1777193250.390389",
            thread_ts: "1777192035.020979",
            text: "<@UBOT> webhook",
          },
        },
      },
    });

    expect(result.trace.nodes.receivedSlackMessage?.value).toMatchObject({
      kind: "app_mention",
      channel: "C123",
      ts: "1777193250.390389",
      threadTs: "1777192035.020979",
      user: "U123",
      text: "<@UBOT> webhook",
    });
  });

  it("fetches recent channel and thread messages", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = String(input);
        if (url.startsWith("https://slack.com/api/conversations.history")) {
          return Response.json({
            ok: true,
            messages: [
              { type: "message", user: "U3", ts: "3.000000", text: "three" },
              { type: "message", user: "U2", ts: "2.000000", text: "two" },
            ],
          });
        }
        if (url.startsWith("https://slack.com/api/conversations.replies")) {
          return Response.json({
            ok: true,
            messages: [
              { type: "message", user: "U1", ts: "1.000000", text: "one" },
              { type: "message", user: "U2", ts: "2.000000", text: "two" },
              { type: "message", user: "U3", ts: "3.000000", text: "three" },
            ],
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      });

    const seed = input("seed", z.object({ ok: z.boolean() }));
    const auth = atom(
      () => ({
        accessToken: "xoxb-test",
        tokenType: "bot",
        scopes: ["channels:history"],
      }),
      { name: "slackAuth" },
    );
    const channel = atom(() => "C123", { name: "channel" });
    const latest = atom(() => "3.000000", { name: "latest" });
    const channelMessages = getChannelMessages({
      auth,
      channel,
      latest,
      inclusive: true,
      limit: 2,
      name: "channelMessages",
    });
    const threadMessages = getThreadMessages({
      auth,
      channel,
      threadTs: "1.000000",
      latest,
      inclusive: true,
      limit: 2,
      name: "threadMessages",
    });

    atom((get) => get(seed), { name: "seedPassThrough" });
    atom(
      (get) => ({
        channel: get(channelMessages).messages.map((message) => message.text),
        thread: get(threadMessages).messages.map((message) => message.text),
      }),
      { name: "messageSummary" },
    );

    const result = await runToIdle({
      kind: "input",
      eventId: "evt-seed",
      runId: "run-slack",
      inputId: "seed",
      payload: { ok: true },
    });

    expect(result.trace.nodes.messageSummary?.value).toEqual({
      channel: ["three", "two"],
      thread: ["two", "three"],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("conversations.history"),
      expect.objectContaining({
        headers: { Authorization: "Bearer xoxb-test" },
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("conversations.replies"),
      expect.objectContaining({
        headers: { Authorization: "Bearer xoxb-test" },
      }),
    );
  });
});
