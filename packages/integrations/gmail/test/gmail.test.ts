import {
  atom,
  createRuntime,
  globalRegistry,
  input,
  secret,
} from "@workflow/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { GMAIL_TOOL_VERSION, sendEmail } from "../src";

async function runToIdle(
  seed: Parameters<ReturnType<typeof createRuntime>["process"]>[0],
  state?: Awaited<
    ReturnType<ReturnType<typeof createRuntime>["process"]>
  >["state"],
  secretValues?: Record<string, string>,
) {
  const runtime = createRuntime({ secretValues });
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

describe("Arcade Gmail tools", () => {
  beforeEach(() => {
    globalRegistry.clear();
    vi.restoreAllMocks();
  });

  it("authorizes and executes Gmail.SendEmail with typed input", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url) => {
        const href = String(url);
        if (href === "https://api.arcade.dev/v1/tools/authorize") {
          return new Response(JSON.stringify({ status: "completed" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (href === "https://api.arcade.dev/v1/tools/execute") {
          return new Response(
            JSON.stringify({
              id: "exec_1",
              execution_id: "exec_1",
              status: "completed",
              success: true,
              output: {
                value: {
                  id: "msg_1",
                  thread_id: "thread_1",
                },
              },
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        return new Response("not found", { status: 404 });
      });

    const seed = input("seed", z.object({ ok: z.boolean().default(true) }));
    const auth = atom(
      () => ({
        apiKey: "arcade-test-key",
        baseUrl: "https://api.arcade.dev",
      }),
      { name: "arcadeAuth" },
    );
    const subject = atom(() => "Quarterly update", { name: "subject" });

    atom((get) => get(seed), { name: "seedPassThrough" });
    const sent = sendEmail({
      auth,
      userId: "user@example.com",
      subject,
      body: "Hello",
      recipient: "recipient@example.com",
      cc: ["cc@example.com"],
      contentType: "plain",
      actionName: "sendGmailEmail",
    });
    atom((get) => get(sent), { name: "sendGmailEmailResult" });

    const result = await runToIdle({
      kind: "input",
      eventId: "evt-seed",
      runId: "run-gmail",
      inputId: "seed",
      payload: { ok: true },
    });

    expect(result.trace.nodes.sendGmailEmail?.status).toBe("resolved");
    expect(result.trace.nodes.sendGmailEmail?.value).toMatchObject({
      toolName: "Gmail.SendEmail",
      toolVersion: GMAIL_TOOL_VERSION,
      value: {
        id: "msg_1",
        thread_id: "thread_1",
      },
    });

    const authorizeBody = JSON.parse(
      String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}"),
    );
    expect(authorizeBody).toEqual({
      tool_name: "Gmail.SendEmail",
      tool_version: GMAIL_TOOL_VERSION,
      user_id: "user@example.com",
    });

    const executeBody = JSON.parse(
      String(fetchMock.mock.calls[1]?.[1]?.body ?? "{}"),
    );
    expect(executeBody).toEqual({
      tool_name: "Gmail.SendEmail",
      tool_version: GMAIL_TOOL_VERSION,
      user_id: "user@example.com",
      input: {
        subject: "Quarterly update",
        body: "Hello",
        recipient: "recipient@example.com",
        cc: ["cc@example.com"],
        content_type: "plain",
      },
    });
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer arcade-test-key",
      "Content-Type": "application/json",
    });
  });

  it("uses ARCADE_USER_ID as the default Arcade authorization identity", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url) => {
        const href = String(url);
        if (href === "https://api.arcade.dev/v1/tools/authorize") {
          return new Response(JSON.stringify({ status: "completed" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (href === "https://api.arcade.dev/v1/tools/execute") {
          return new Response(
            JSON.stringify({
              status: "completed",
              success: true,
              output: {
                value: {
                  id: "msg_1",
                  thread_id: "thread_1",
                },
              },
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        return new Response("not found", { status: 404 });
      });

    const seed = input("seed", z.object({ ok: z.boolean().default(true) }));
    const auth = atom(
      () => ({
        apiKey: "arcade-test-key",
        baseUrl: "https://api.arcade.dev",
      }),
      { name: "arcadeAuth" },
    );
    secret("ARCADE_USER_ID", undefined);

    atom((get) => get(seed), { name: "seedPassThrough" });
    const sent = sendEmail({
      auth,
      subject: "Quarterly update",
      body: "Hello",
      recipient: "recipient@example.com",
      actionName: "sendGmailEmail",
    });
    atom((get) => get(sent), { name: "sendGmailEmailResult" });

    await runToIdle(
      {
        kind: "input",
        eventId: "evt-seed",
        runId: "run-gmail",
        inputId: "seed",
        payload: { ok: true },
      },
      undefined,
      { ARCADE_USER_ID: "ani@smithery.ai" },
    );

    const authorizeBody = JSON.parse(
      String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}"),
    );
    expect(authorizeBody.user_id).toBe("ani@smithery.ai");
    expect(authorizeBody.user_id).not.toBe("hylo:run-gmail");

    const executeBody = JSON.parse(
      String(fetchMock.mock.calls[1]?.[1]?.body ?? "{}"),
    );
    expect(executeBody.user_id).toBe("ani@smithery.ai");
  });
});
