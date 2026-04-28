import { describe, expect, it } from "vitest";
import { z } from "zod";
import { atom } from "../src/atom";
import { input } from "../src/input";
import { createRuntime } from "../src/runtime";
import type { QueueEvent, RunState } from "../src/types";
import { resetRegistry } from "./helpers";

describe("runtime.process — retry semantics", () => {
  resetRegistry();

  it("re-emits step events when an input event is reprocessed", async () => {
    // Models the production failure: a worker saved state with
    // processedEventIds=true but died before its emitted fan-out reached the
    // queue. On retry, runtime.process used to short-circuit on
    // hasProcessed and return emitted=[], leaving the run permanently
    // stalled. Re-running an input event is safe (handleInputEvent is
    // idempotent), so we must re-emit.
    const trigger = input("trigger", z.object({ ok: z.boolean() }));
    atom((get) => get(trigger), { name: "after" });

    const runtime = createRuntime();
    const event: QueueEvent = {
      kind: "input",
      eventId: "evt-input-once",
      runId: "run-1",
      inputId: "trigger",
      payload: { ok: true },
    };

    const first = await runtime.process(event);
    expect(first.emitted.length).toBeGreaterThan(0);
    expect(first.state.processedEventIds[event.eventId]).toBe(true);

    // Pretend the worker died before the emitted events reached the queue:
    // state was saved (with processedEventIds=true) but no follow-up
    // events were enqueued. Replay the same event against the saved state.
    const second = await runtime.process(event, first.state);

    expect(second.emitted.length).toBe(first.emitted.length);
    expect(
      second.emitted.map((e) => (e.kind === "step" ? e.stepId : e.kind)),
    ).toEqual(
      first.emitted.map((e) => (e.kind === "step" ? e.stepId : e.kind)),
    );
  });

  it("short-circuits a reprocessed step event to avoid double side-effects", async () => {
    // Step events can have side effects (actions performing I/O), so
    // once processed they must NOT re-run on retry. processedEventIds
    // is the guard.
    const seed = input("seed", z.object({ value: z.number() }));
    atom((get) => get(seed).value + 1, { name: "increment" });

    const runtime = createRuntime();
    const inputEvent: QueueEvent = {
      kind: "input",
      eventId: "evt-input",
      runId: "run-2",
      inputId: "seed",
      payload: { value: 1 },
    };

    const afterInput = await runtime.process(inputEvent);
    const stepEvent = afterInput.emitted[0];
    expect(stepEvent?.kind).toBe("step");
    if (!stepEvent) throw new Error("expected an emitted step event");

    let stateAfterStep: RunState = afterInput.state;
    const firstStep = await runtime.process(stepEvent, stateAfterStep);
    stateAfterStep = firstStep.state;
    expect(firstStep.state.processedEventIds[stepEvent.eventId]).toBe(true);

    // Replay the same step event — must be a no-op.
    const replayedStep = await runtime.process(stepEvent, stateAfterStep);
    expect(replayedStep.emitted).toEqual([]);
  });
});
