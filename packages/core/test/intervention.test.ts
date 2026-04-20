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
    resumedState.interventionResponses[interventionId] = { approved: true };
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
  });
});
