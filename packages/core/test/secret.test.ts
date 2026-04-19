import { describe, expect, it } from "vitest";
import { z } from "zod";
import { atom, input, secret } from "../src";
import { createRuntime } from "../src/runtime";
import { assertResolved, resetRegistry, runToIdle } from "./helpers";

describe("secret()", () => {
  resetRegistry();

  it("can be read by downstream atoms without exposing the raw value in node records", async () => {
    const request = input("request", z.object({ prompt: z.string() }));
    const apiKey = secret.named("AI_GATEWAY_API_KEY", "sk-test-secret");

    atom(
      (get) => {
        const r = get(request);
        const key = get(apiKey);
        return { prompt: r.prompt, authenticated: key === "sk-test-secret" };
      },
      { name: "callGateway" },
    );

    const runtime = createRuntime();
    const { state, trace } = await runToIdle(runtime, {
      kind: "input",
      eventId: "evt-request",
      runId: "run-secret",
      inputId: "request",
      payload: { prompt: "hello" },
    });

    assertResolved(trace, "callGateway", {
      prompt: "hello",
      authenticated: true,
    });
    assertResolved(trace, "AI_GATEWAY_API_KEY", "[secret]");
    expect(trace.nodes.callGateway.deps).toContain("AI_GATEWAY_API_KEY");
    expect(JSON.stringify(trace.nodes)).not.toContain("sk-test-secret");
    expect(state.secrets).toEqual({});
  });

  it("prefers run-state secret overrides over declaration defaults", async () => {
    const request = input("request", z.object({ prompt: z.string() }));
    const apiKey = secret.named("AI_GATEWAY_API_KEY", "sk-default");

    atom(
      (get) => ({
        prompt: get(request).prompt,
        authenticated: get(apiKey) === "sk-client",
      }),
      { name: "callGateway" },
    );

    const runtime = createRuntime();
    const { trace } = await runToIdle(
      runtime,
      {
        kind: "input",
        eventId: "evt-request",
        runId: "run-secret-override",
        inputId: "request",
        payload: { prompt: "hello" },
      },
      {
        runId: "run-secret-override",
        startedAt: Date.now(),
        inputs: {},
        secrets: { AI_GATEWAY_API_KEY: "sk-client" },
        nodes: {},
        waiters: {},
        processedEventIds: {},
      },
    );

    assertResolved(trace, "callGateway", {
      prompt: "hello",
      authenticated: true,
    });
    assertResolved(trace, "AI_GATEWAY_API_KEY", "[secret]");
    expect(JSON.stringify(trace.nodes)).not.toContain("sk-client");
  });
});
