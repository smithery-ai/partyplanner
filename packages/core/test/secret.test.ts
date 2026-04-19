import { describe, expect, it } from "vitest";
import { atom } from "../src/atom";
import { secret } from "../src/input";
import { createRuntime } from "../src/runtime";
import { assertResolved, resetRegistry, runToIdle } from "./helpers";

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

    const runtime = createRuntime();
    const { state, trace } = await runToIdle(runtime, {
      kind: "input",
      eventId: "evt-1",
      runId: "run-1",
      inputId: "apiKey",
      payload: "sk-live-123",
    });

    expect(apiKey.__kind).toBe("input");
    expect(state.inputs.apiKey).toBe("sk-live-123");
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

  it("does not expose a deferred secret helper", () => {
    expect("deferred" in secret).toBe(false);
  });
});
