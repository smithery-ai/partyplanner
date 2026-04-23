import { describe, expect, it } from "vitest";
import { z } from "zod";
import { atom } from "../src/atom";
import { input } from "../src/input";
import { createRuntime } from "../src/runtime";
import {
  assertErrored,
  assertResolved,
  assertSkipped,
  assertWaiting,
  resetRegistry,
  runToIdle,
} from "./helpers";

describe("README runtime guarantees", () => {
  resetRegistry();

  it.fails("recomputes derived atoms when a later input event changes their dependency", async () => {
    const slack = input("slack", z.object({ text: z.string() }));

    atom(
      (get) => {
        const { text } = get(slack);
        return text.includes("urgent") ? "urgent" : "normal";
      },
      { name: "classify" },
    );

    const runtime = createRuntime();
    const first = await runToIdle(runtime, {
      kind: "input",
      eventId: "evt-1",
      runId: "run-1",
      inputId: "slack",
      payload: { text: "hello" },
    });

    assertResolved(first.trace, "classify", "normal");

    const second = await runToIdle(
      runtime,
      {
        kind: "input",
        eventId: "evt-2",
        runId: "run-1",
        inputId: "slack",
        payload: { text: "urgent outage" },
      },
      first.state,
    );

    assertResolved(second.trace, "classify", "urgent");
  });

  it.fails("recovers a skipped normal-input branch when that input arrives later", async () => {
    const slack = input("slack", z.object({ text: z.string() }));
    const github = input("github", z.object({ diff: z.string() }));

    atom(
      (get) => {
        const { diff } = get(github);
        return diff.split("\n").length;
      },
      { name: "review" },
    );

    atom(
      (get) => {
        return get(slack).text;
      },
      { name: "echo" },
    );

    const runtime = createRuntime();
    const first = await runToIdle(runtime, {
      kind: "input",
      eventId: "evt-1",
      runId: "run-1",
      inputId: "slack",
      payload: { text: "hello" },
    });

    assertResolved(first.trace, "echo", "hello");
    assertSkipped(first.trace, "review");

    const second = await runToIdle(
      runtime,
      {
        kind: "input",
        eventId: "evt-2",
        runId: "run-1",
        inputId: "github",
        payload: { diff: "a\nb\nc" },
      },
      first.state,
    );

    expect(second.trace.nodes.review.status).toBe("resolved");
    expect(second.trace.nodes.review.value).toBe(3);
  });

  it("propagates an unexpected atom error to downstream dependents", async () => {
    const trigger = input("trigger", z.object({ text: z.string() }));

    const explode = atom(
      (get) => {
        get(trigger);
        throw new Error("boom");
      },
      { name: "explode" },
    );

    atom(
      (get) => {
        return `downstream:${get(explode)}`;
      },
      { name: "downstream" },
    );

    const runtime = createRuntime();
    const { trace } = await runToIdle(runtime, {
      kind: "input",
      eventId: "evt-1",
      runId: "run-1",
      inputId: "trigger",
      payload: { text: "go" },
    });

    assertErrored(trace, "explode", "boom");
    assertErrored(trace, "downstream", "boom");
  });

  it("treats duplicate webhook delivery event IDs as idempotent re-entry", async () => {
    const webhook = input("webhook", z.object({ body: z.string() }));

    atom(
      (get) => {
        return get(webhook).body;
      },
      { name: "extract" },
    );

    const runtime = createRuntime();
    const first = await runToIdle(runtime, {
      kind: "input",
      eventId: "evt-webhook-1",
      runId: "run-webhook",
      inputId: "webhook",
      payload: { body: "first delivery" },
    });

    const replay = await runToIdle(
      runtime,
      {
        kind: "input",
        eventId: "evt-webhook-1",
        runId: "run-webhook",
        inputId: "webhook",
        payload: { body: "mutated duplicate" },
      },
      first.state,
    );

    assertResolved(replay.trace, "extract", "first delivery");
    expect(replay.state.processedEventIds["evt-webhook-1"]).toBe(true);
  });

  it.fails("rejects stale human prompt responses after workflow re-entry changes the prompt context", async () => {
    const seed = input("seed", z.object({ name: z.string() }));

    atom(
      (get, requestIntervention) => {
        const { name } = get(seed);
        const approval = requestIntervention(
          "approval",
          z.object({ approved: z.boolean() }),
          {
            title: `Approve ${name}`,
            description: `Approval is scoped to ${name}`,
            actionUrl: `https://example.com/approve?name=${name}`,
          },
        );
        if (!approval.approved) return get.skip("Approval was denied");
        return `approved:${name}`;
      },
      { name: "deploy" },
    );

    const runtime = createRuntime();
    const first = await runToIdle(runtime, {
      kind: "input",
      eventId: "evt-seed-1",
      runId: "run-human",
      inputId: "seed",
      payload: { name: "Ada" },
    });

    const interventionId = "deploy:approval";
    assertWaiting(first.trace, "deploy", interventionId);
    expect(first.state.interventions[interventionId]?.title).toBe(
      "Approve Ada",
    );

    const reentered = await runToIdle(
      runtime,
      {
        kind: "input",
        eventId: "evt-seed-2",
        runId: "run-human",
        inputId: "seed",
        payload: { name: "Bob" },
      },
      first.state,
    );

    assertWaiting(reentered.trace, "deploy", interventionId);
    expect(reentered.state.interventions[interventionId]?.title).toBe(
      "Approve Bob",
    );

    const staleApprovalState = structuredClone(reentered.state);
    staleApprovalState.interventionResponses[interventionId] = {
      approved: true,
    };
    staleApprovalState.interventions[interventionId] = {
      ...staleApprovalState.interventions[interventionId],
      status: "resolved",
      resolvedAt: Date.now(),
    };

    const afterStaleApproval = await runToIdle(
      runtime,
      {
        kind: "step",
        eventId: "evt-stale-approval",
        runId: "run-human",
        stepId: "deploy",
      },
      staleApprovalState,
    );

    assertWaiting(afterStaleApproval.trace, "deploy", interventionId);
  });
});
