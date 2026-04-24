import type { RunState } from "@workflow/core";
import { describe, expect, it } from "vitest";
import type { WorkflowManifest } from "../types";
import { collectUnresolvedWaitingOn, findPendingWait } from "./pending-wait";

function makeRunState(overrides: Partial<RunState> = {}): RunState {
  return {
    runId: "run_123",
    startedAt: Date.now(),
    inputs: {},
    interventions: {},
    interventionResponses: {},
    nodes: {},
    waiters: {},
    processedEventIds: {},
    ...overrides,
  };
}

describe("findPendingWait", () => {
  it("does not treat resolved interventions as pending input", () => {
    const manifest: WorkflowManifest = {
      workflowId: "workflow",
      name: "Workflow",
      version: "1",
      createdAt: Date.now(),
      inputs: [],
      atoms: [],
      actions: [],
    };
    const state = makeRunState({
      interventions: {
        "notion:oauth-callback": {
          id: "notion:oauth-callback",
          stepId: "notion",
          key: "oauth-callback",
          status: "resolved",
          createdAt: Date.now(),
          resolvedAt: Date.now(),
          title: "Notion OAuth callback",
          schema: { type: "object", properties: {} },
        },
      },
      nodes: {
        notion: {
          status: "waiting",
          kind: "atom",
          deps: [],
          duration_ms: 0,
          attempts: 1,
          waitingOn: "notion:oauth-callback",
        },
      },
    });

    expect(findPendingWait(manifest, state)).toBeUndefined();
    expect(collectUnresolvedWaitingOn(state)).toEqual([]);
  });

  it("keeps unresolved interventions pending", () => {
    const state = makeRunState({
      interventions: {
        "notion:oauth-callback": {
          id: "notion:oauth-callback",
          stepId: "notion",
          key: "oauth-callback",
          status: "pending",
          createdAt: Date.now(),
          title: "Notion OAuth callback",
          schema: { type: "object", properties: {} },
        },
      },
      nodes: {
        notion: {
          status: "waiting",
          kind: "atom",
          deps: [],
          duration_ms: 0,
          attempts: 1,
          waitingOn: "notion:oauth-callback",
        },
      },
    });

    expect(findPendingWait(undefined, state)).toEqual({
      stepId: "notion",
      kind: "intervention",
      interventionId: "notion:oauth-callback",
    });
    expect(collectUnresolvedWaitingOn(state)).toEqual([
      "notion:oauth-callback",
    ]);
  });

  it("does not report waits for resolved deferred inputs", () => {
    const manifest: WorkflowManifest = {
      workflowId: "workflow",
      name: "Workflow",
      version: "1",
      createdAt: Date.now(),
      inputs: [
        {
          id: "approval",
          kind: "deferred_input",
          title: "Approval",
          schema: { type: "object", properties: {} },
        },
      ],
      atoms: [],
      actions: [],
    };
    const state = makeRunState({
      nodes: {
        approval: {
          status: "resolved",
          kind: "deferred_input",
          deps: [],
          duration_ms: 0,
          attempts: 1,
          value: { approved: true },
        },
        submit: {
          status: "waiting",
          kind: "atom",
          deps: [],
          duration_ms: 0,
          attempts: 1,
          waitingOn: "approval",
        },
      },
    });

    expect(findPendingWait(manifest, state)).toBeUndefined();
    expect(collectUnresolvedWaitingOn(state)).toEqual([]);
  });
});
