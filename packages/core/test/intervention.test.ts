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

describe("requestIntervention", () => {
  resetRegistry();

  it("pauses a step on a dynamic intervention and resumes with the response", async () => {
    const seed = input("seed", z.object({ name: z.string() }));

    atom(
      (get, requestIntervention) => {
        const initial = get(seed);
        const approval = requestIntervention(
          "approval",
          z.object({ approved: z.boolean() }),
          {
            title: "Approve deploy",
            description: `Approve ${initial.name}`,
            action: {
              type: "open_url",
              url: `https://example.com/approve?name=${initial.name}`,
              label: "Review",
            },
          },
        );
        if (!approval.approved) return get.skip("Approval was denied");
        return `approved:${initial.name}`;
      },
      { name: "deploy" },
    );

    const runtime = createRuntime();
    const run1 = await runToIdle(runtime, {
      kind: "input",
      eventId: "evt-1",
      runId: "run-1",
      inputId: "seed",
      payload: { name: "Ada" },
    });

    const interventionId = "deploy:approval";
    assertWaiting(run1.trace, "deploy", interventionId);
    expect(run1.state.interventions[interventionId]).toMatchObject({
      id: interventionId,
      stepId: "deploy",
      key: "approval",
      status: "pending",
      title: "Approve deploy",
      description: "Approve Ada",
      action: {
        type: "open_url",
        url: "https://example.com/approve?name=Ada",
        label: "Review",
      },
    });
    expect(run1.state.waiters[interventionId]).toEqual(["deploy"]);

    const resumedState = structuredClone(run1.state);
    resumedState.inputs[interventionId] = { approved: true };
    resumedState.interventions[interventionId] = {
      ...resumedState.interventions[interventionId],
      status: "resolved",
      resolvedAt: Date.now(),
    };

    const run2 = await runToIdle(
      runtime,
      {
        kind: "step",
        eventId: "evt-2",
        runId: "run-1",
        stepId: "deploy",
      },
      resumedState,
    );

    assertResolved(run2.trace, "deploy", "approved:Ada");
    expect(run2.state.inputs[interventionId]).toEqual({ approved: true });
  });

  it("passes run context to intervention-producing atoms", async () => {
    const seed = input("contextSeed", z.object({ name: z.string() }));

    atom(
      (get, requestIntervention, context) => {
        get(seed);
        requestIntervention("approval", z.object({ approved: z.boolean() }), {
          action: {
            type: "open_url",
            url: `https://example.com/oauth?run=${context.runId}&intervention=${context.interventionId("approval")}`,
          },
        });
        return "done";
      },
      { name: "contextDeploy" },
    );

    const runtime = createRuntime();
    const run = await runToIdle(runtime, {
      kind: "input",
      eventId: "evt-context",
      runId: "run-context",
      inputId: "contextSeed",
      payload: { name: "Ada" },
    });

    expect(
      run.state.interventions["contextDeploy:approval"]?.action,
    ).toMatchObject({
      type: "open_url",
      url: "https://example.com/oauth?run=run-context&intervention=contextDeploy:approval",
    });
  });
});
