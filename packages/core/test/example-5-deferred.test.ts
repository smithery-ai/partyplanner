import { describe, expect, it } from "vitest";
import { z } from "zod";
import { atom } from "../src/atom";
import { input } from "../src/input";
import { createRuntime } from "../src/runtime";
import {
  assertResolved,
  assertWaiting,
  resetRegistry,
  runToIdle,
} from "./helpers";

describe("Example 5 — Deferred input (durable workflow)", () => {
  resetRegistry();

  it("pauses on deferred input, resumes when approval arrives", async () => {
    let assessmentCallCount = 0;

    const expense = input(
      "expense",
      z.object({
        amount: z.number(),
        description: z.string(),
      }),
    );

    const approval = input.deferred(
      "approval",
      z.object({
        approved: z.boolean(),
      }),
    );

    const assessment = atom(
      (get) => {
        const e = get(expense);
        assessmentCallCount++;
        return e.amount > 1000 ? "high" : "low";
      },
      { name: "assessment" },
    );

    const _submit = atom(
      (get) => {
        const e = get(expense);
        const a = get(assessment);
        const decision = get(approval);
        if (!decision.approved) return get.skip("Approval was denied");
        return `submitted: ${e.description} ($${e.amount}, ${a} risk)`;
      },
      { name: "submit" },
    );

    const runtime = createRuntime();

    // Run 1: seed expense input event
    const run1 = await runToIdle(runtime, {
      kind: "input",
      eventId: "evt-1",
      runId: "run-1",
      inputId: "expense",
      payload: { amount: 5000, description: "Conference tickets" },
    });

    assertResolved(run1.trace, "expense");
    assertResolved(run1.trace, "assessment", "high");
    assertWaiting(run1.trace, "submit", "approval");
    expect(assessmentCallCount).toBe(1);

    // Verify submit is registered as a waiter of approval
    expect(run1.state.waiters.approval).toContain("submit");

    // Run 2: seed approval input event with prior RunState
    const run2 = await runToIdle(
      runtime,
      {
        kind: "input",
        eventId: "evt-2",
        runId: "run-1",
        inputId: "approval",
        payload: { approved: true },
      },
      run1.state,
    );

    assertResolved(
      run2.trace,
      "submit",
      "submitted: Conference tickets ($5000, high risk)",
    );
    // Assessment should NOT have re-executed
    expect(assessmentCallCount).toBe(1);
  });
});
