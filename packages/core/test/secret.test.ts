import { describe, expect, it } from "vitest";
import { z } from "zod";
import { atom } from "../src/atom";
import { input, secret } from "../src/input";
import { createRuntime } from "../src/runtime";
import {
  assertResolved,
  assertWaiting,
  resetRegistry,
  runToIdle,
} from "./helpers";

describe("secret()", () => {
  resetRegistry();

  it("behaves like input while redacting trace values", async () => {
    const apiKey = secret("API_KEY", undefined, {
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
        API_KEY: "sk-live-123",
      },
    });
    const { state, trace } = await runToIdle(runtime, {
      kind: "input",
      eventId: "evt-1",
      runId: "run-1",
      inputId: "API_KEY",
      payload: "sk-live-123",
    });

    expect(apiKey.__kind).toBe("input");
    expect(state.inputs.API_KEY).toBeUndefined();
    expect(trace.payload).toBe("[secret]");
    assertResolved(trace, "API_KEY", "[secret]");
    assertResolved(trace, useKey.__id, "sk-");
  });

  it("validates secret payloads as strings", async () => {
    secret("API_KEY", undefined);

    const runtime = createRuntime();
    await expect(
      runtime.process({
        kind: "input",
        eventId: "evt-1",
        runId: "run-1",
        inputId: "API_KEY",
        payload: { token: "sk-live-123" },
      }),
    ).rejects.toThrow();
  });

  it("rejects empty secret payloads", async () => {
    secret("API_KEY", undefined);

    const runtime = createRuntime();
    await expect(
      runtime.process({
        kind: "input",
        eventId: "evt-1",
        runId: "run-1",
        inputId: "API_KEY",
        payload: "",
      }),
    ).rejects.toThrow("Secret must not be empty.");
  });

  it("waits when a step reads a missing secret", async () => {
    const seed = input("seed", z.string());
    const apiKey = secret("API_KEY", undefined);

    atom(
      (get) => {
        get(seed);
        return get(apiKey);
      },
      { name: "useSecret" },
    );

    const runtime = createRuntime();
    const { trace } = await runToIdle(runtime, {
      kind: "input",
      eventId: "evt-1",
      runId: "run-1",
      inputId: "seed",
      payload: "start",
    });

    assertWaiting(trace, "useSecret", "API_KEY");
  });

  it("wakes downstream steps that inherited a secret wait", async () => {
    const seed = input("seed", z.string());
    const apiKey = secret("API_KEY", undefined);

    const loadSecret = atom(
      (get) => {
        get(seed);
        return get(apiKey);
      },
      { name: "loadSecret" },
    );

    atom(
      (get) => {
        const key = get(loadSecret);
        return key.slice(0, 3);
      },
      { name: "useSecret" },
    );

    const initialRuntime = createRuntime();
    const { state: waitingState, trace: waitingTrace } = await runToIdle(
      initialRuntime,
      {
        kind: "input",
        eventId: "evt-seed",
        runId: "run-1",
        inputId: "seed",
        payload: "start",
      },
    );

    assertWaiting(waitingTrace, "loadSecret", "API_KEY");
    assertWaiting(waitingTrace, "useSecret", "API_KEY");

    const resumedRuntime = createRuntime({
      secretValues: {
        API_KEY: "sk-live-123",
      },
    });
    const { trace } = await runToIdle(
      resumedRuntime,
      {
        kind: "input",
        eventId: "evt-secret",
        runId: "run-1",
        inputId: "API_KEY",
        payload: "sk-live-123",
      },
      waitingState,
    );

    assertResolved(trace, "API_KEY", "[secret]");
    assertResolved(trace, "loadSecret", "sk-live-123");
    assertResolved(trace, "useSecret", "sk-");
  });

  it("does not expose a deferred secret helper", () => {
    expect("deferred" in secret).toBe(false);
  });
});
