import { describe, expect, it } from "vitest";
import { z } from "zod";
import { atom } from "../src/atom";
import { input } from "../src/input";
import { createRuntime } from "../src/runtime";
import type { StepSkippedEvent } from "../src/types";
import { resetRegistry, runToIdle } from "./helpers";

describe("skip reasons", () => {
  resetRegistry();

  it("stores the optional reason from get.skip(reason)", async () => {
    const request = input("request", z.object({ approved: z.boolean() }));

    const gated = atom(
      (get) => {
        const r = get(request);
        if (!r.approved) return get.skip("approval denied");
        return "approved";
      },
      { name: "gated" },
    );

    atom(
      (get) => {
        const value = get(gated);
        return `next: ${value}`;
      },
      { name: "next" },
    );

    const skipped: StepSkippedEvent[] = [];
    const runtime = createRuntime({
      onStepSkipped: (ev) => skipped.push(ev),
    });
    const { trace } = await runToIdle(runtime, {
      kind: "input",
      eventId: "evt-1",
      runId: "run-1",
      inputId: "request",
      payload: { approved: false },
    });

    expect(trace.nodes.gated?.status).toBe("skipped");
    expect(trace.nodes.gated?.skipReason).toBe("approval denied");
    expect(trace.nodes.next?.status).toBe("skipped");
    expect(trace.nodes.next?.skipReason).toBe("approval denied");
    expect(skipped).toEqual(
      expect.arrayContaining([
        { id: "gated", reason: "approval denied" },
        { id: "next", reason: "approval denied" },
      ]),
    );
  });
});
