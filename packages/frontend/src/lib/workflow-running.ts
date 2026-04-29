import type { RunState } from "@workflow/core";

export function inferClientRunningNodeIds(
  runState: RunState | undefined,
): string[] {
  if (!runState) return [];

  const result: string[] = [];
  for (const [nodeId, record] of Object.entries(runState.nodes)) {
    if (record.status !== "blocked" || !record.blockedOn) continue;
    if (dependencyCanUnblock(runState, record.blockedOn)) {
      result.push(nodeId);
    }
  }
  return result;
}

function dependencyCanUnblock(
  runState: RunState,
  dependencyId: string,
): boolean {
  if (runState.nodes[dependencyId]?.status === "resolved") return true;
  return Object.hasOwn(runState.inputs, dependencyId);
}
