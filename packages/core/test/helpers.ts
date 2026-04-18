import { beforeEach, expect } from "vitest";
import { globalRegistry } from "../src/registry";
import type { Runtime, RunState, RunTrace, QueueEvent } from "../src/types";

export function resetRegistry() {
  beforeEach(() => globalRegistry.clear());
}

export async function runToIdle(
  runtime: Runtime,
  seed: QueueEvent,
  state?: RunState
): Promise<{ state: RunState; trace: RunTrace }> {
  const queue = [seed];
  let current = state;
  let trace!: RunTrace;

  while (queue.length > 0) {
    const event = queue.shift()!;
    const result = await runtime.process(event, current);
    current = result.state;
    trace = result.trace;
    queue.push(...result.emitted);
  }

  return { state: current!, trace };
}

export function assertResolved(trace: RunTrace, id: string, expectedValue?: unknown) {
  const a = trace.nodes[id];
  if (!a) throw new Error(`No record for "${id}"`);
  if (a.status !== "resolved") {
    throw new Error(`Expected "${id}" resolved, got "${a.status}" (error: ${a.error?.message})`);
  }
  if (expectedValue !== undefined) {
    expect(a.value).toEqual(expectedValue);
  }
}

export function assertSkipped(trace: RunTrace, id: string) {
  expect(trace.nodes[id]?.status).toBe("skipped");
}

export function assertWaiting(trace: RunTrace, id: string, waitingOn?: string) {
  expect(trace.nodes[id]?.status).toBe("waiting");
  if (waitingOn) expect(trace.nodes[id]?.waitingOn).toBe(waitingOn);
}
