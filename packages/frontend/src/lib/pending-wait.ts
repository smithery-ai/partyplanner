import type { RunState } from "@workflow/core";
import type { WorkflowInputManifest, WorkflowManifest } from "../types";

export type PendingWait =
  | { stepId: string; kind: "input"; inputId: string }
  | { stepId: string; kind: "intervention"; interventionId: string };

function findManifestInput(
  manifest: WorkflowManifest | undefined,
  inputId: string | undefined,
): WorkflowInputManifest | undefined {
  if (!inputId) return undefined;
  return manifest?.inputs.find((input) => input.id === inputId);
}

function interventionStillPending(
  state: RunState,
  waitingOn: string,
): boolean | undefined {
  const intervention = state.interventions?.[waitingOn];
  if (!intervention) return undefined;
  return intervention.status !== "resolved";
}

export function collectUnresolvedWaitingOn(state: RunState): string[] {
  const waitingOn = new Set<string>();
  for (const node of Object.values(state.nodes)) {
    if (!node.waitingOn || node.status !== "waiting") continue;
    if (interventionStillPending(state, node.waitingOn) === false) continue;
    if (state.nodes[node.waitingOn]?.status === "resolved") continue;
    waitingOn.add(node.waitingOn);
  }
  return [...waitingOn];
}

export function findPendingWait(
  manifest: WorkflowManifest | undefined,
  state: RunState | undefined,
): PendingWait | undefined {
  if (!state?.nodes) return undefined;
  for (const [stepId, node] of Object.entries(state.nodes)) {
    if (node.status !== "waiting" || !node.waitingOn) continue;

    const pendingIntervention = interventionStillPending(state, node.waitingOn);
    if (pendingIntervention === true) {
      return {
        stepId,
        kind: "intervention",
        interventionId: node.waitingOn,
      };
    }
    if (pendingIntervention === false) continue;

    const waitingOn = findManifestInput(manifest, node.waitingOn);
    if (
      !waitingOn?.secret &&
      state.nodes[node.waitingOn]?.status === "resolved"
    ) {
      continue;
    }

    return { stepId, kind: "input", inputId: node.waitingOn };
  }
  return undefined;
}
