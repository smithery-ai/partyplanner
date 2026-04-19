import { describe, expect, it } from "vitest";
import { z } from "zod";
import { atom } from "../src/atom";
import { input, secret } from "../src/input";
import { createRuntime } from "../src/runtime";
import {
  assertErrored,
  assertResolved,
  assertSkipped,
  resetRegistry,
  runToIdle,
} from "./helpers";

describe("secret()", () => {
  resetRegistry();

  it("behaves like input while redacting trace values", async () => {
    const apiKey = secret("apiKey", {
      description: "API key used by the workflow.",
    });

    const useKey = atom(
      (get) => {
        const key = get(apiKey);
        return key.slice(0, 3);
      },
      { name: "useKey" },
    );

    const runtime = createRuntime({
      secretValues: {
        apiKey: "sk-live-123",
      },
    });
    const { state, trace } = await runToIdle(runtime, {
      kind: "input",
      eventId: "evt-1",
      runId: "run-1",
      inputId: "apiKey",
      payload: "sk-live-123",
    });

    expect(apiKey.__kind).toBe("input");
    expect(state.inputs.apiKey).toBeUndefined();
    expect(trace.payload).toBe("[secret]");
    assertResolved(trace, "apiKey", "[secret]");
    assertResolved(trace, useKey.__id, "sk-");
  });

  it("validates secret payloads as strings", async () => {
    secret("apiKey");

    const runtime = createRuntime();
    await expect(
      runtime.process({
        kind: "input",
        eventId: "evt-1",
        runId: "run-1",
        inputId: "apiKey",
        payload: { token: "sk-live-123" },
      }),
    ).rejects.toThrow();
  });

  it("rejects empty secret payloads", async () => {
    secret("apiKey");

    const runtime = createRuntime();
    await expect(
      runtime.process({
        kind: "input",
        eventId: "evt-1",
        runId: "run-1",
        inputId: "apiKey",
        payload: "",
      }),
    ).rejects.toThrow("Secret must not be empty.");
  });

  it("errors the secret and skips downstream when a secret is unresolved", async () => {
    const seed = input("seed", z.string());
    const apiKey = secret("apiKey");

    atom(
      (get) => {
        get(seed);
        return get(apiKey);
      },
      { name: "useSecret" },
    );

    atom(
      (get) => {
        const key = get(apiKey);
        return `downstream:${key}`;
      },
      { name: "downstream" },
    );

    const runtime = createRuntime();
    const { trace } = await runToIdle(runtime, {
      kind: "input",
      eventId: "evt-1",
      runId: "run-1",
      inputId: "seed",
      payload: "start",
    });

    assertErrored(trace, "apiKey", 'Secret "apiKey" could not be resolved');
    assertSkipped(trace, "useSecret");
    assertSkipped(trace, "downstream");
    expect(trace.nodes.useSecret?.skipReason).toBe(
      'Secret "apiKey" could not be resolved',
    );
    expect(trace.nodes.downstream?.skipReason).toBe(
      'Secret "apiKey" could not be resolved',
    );
  });

  it("does not expose a deferred secret helper", () => {
    expect("deferred" in secret).toBe(false);
  });
});
