import type { RunState } from "@workflow/core";
import { describe, expect, it } from "vitest";
import { inferClientRunningNodeIds } from "./workflow-running";

function makeRunState(overrides: Partial<RunState> = {}): RunState {
  return {
    runId: "run_123",
    startedAt: Date.now(),
    inputs: {},
    interventions: {},
    nodes: {},
    waiters: {},
    processedEventIds: {},
    ...overrides,
  };
}

describe("inferClientRunningNodeIds", () => {
  it("marks blocked nodes as running after their blocked dependency resolves", () => {
    const state = makeRunState({
      nodes: {
        readEmails: {
          status: "resolved",
          kind: "atom",
          value: [],
          deps: [],
          duration_ms: 10,
          attempts: 1,
        },
        summarizeEmails: {
          status: "blocked",
          kind: "atom",
          deps: ["readEmails"],
          duration_ms: 1,
          attempts: 1,
          blockedOn: "readEmails",
        },
      },
    });

    expect(inferClientRunningNodeIds(state)).toEqual(["summarizeEmails"]);
  });

  it("does not mark nodes blocked on unresolved workflow state", () => {
    const state = makeRunState({
      nodes: {
        sendUpdate: {
          status: "waiting",
          kind: "atom",
          deps: ["approval"],
          duration_ms: 1,
          attempts: 1,
          waitingOn: "approval",
        },
        wrapUp: {
          status: "blocked",
          kind: "atom",
          deps: ["sendUpdate"],
          duration_ms: 1,
          attempts: 1,
          blockedOn: "sendUpdate",
        },
      },
    });

    expect(inferClientRunningNodeIds(state)).toEqual([]);
  });

  it("does not mark managed connection configuration blockers as running", () => {
    const state = makeRunState({
      nodes: {
        notion: {
          status: "blocked",
          kind: "atom",
          deps: [],
          duration_ms: 1,
          attempts: 1,
          blockedOn: "@configuration/notion",
        },
      },
    });

    expect(inferClientRunningNodeIds(state)).toEqual([]);
  });

  it("treats submitted inputs as ready even before an input node is materialized", () => {
    const state = makeRunState({
      inputs: {
        incidentAlert: { service: "checkout-api" },
      },
      nodes: {
        triage: {
          status: "blocked",
          kind: "atom",
          deps: ["incidentAlert"],
          duration_ms: 1,
          attempts: 1,
          blockedOn: "incidentAlert",
        },
      },
    });

    expect(inferClientRunningNodeIds(state)).toEqual(["triage"]);
  });
});
