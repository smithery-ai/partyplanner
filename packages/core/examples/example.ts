import { createRuntime } from "../src/index";
import type { QueueEvent, RunState, RunTrace } from "../src/types";
import { overlayReview, prodApproval, provider } from "./example-workflow";

// ── Run it ───────────────────────────────────────────────────────

const runtime = createRuntime({
  onStepResolved: (ev) =>
    console.log(`  ✓ ${ev.id} resolved (${ev.duration_ms}ms)`),
  onStepSkipped: (ev) => console.log(`  ⊘ ${ev.id} skipped`),
  onStepBlocked: (ev) =>
    console.log(`  ⏳ ${ev.id} blocked on ${ev.blockedOn}`),
  onStepWaiting: (ev) => console.log(`  ⏸ ${ev.id} waiting on ${ev.waitingOn}`),
  onStepErrored: (ev) =>
    console.log(`  ✗ ${ev.id} errored: ${ev.error.message}`),
});

async function drainQueue(seed: QueueEvent, state?: RunState) {
  const queue = [seed];
  let current: RunState | undefined = state;
  let trace: RunTrace | undefined;

  while (queue.length > 0) {
    const event = queue.shift();
    if (event === undefined) break;
    const label =
      event.kind === "input"
        ? `input:${event.inputId}`
        : `step:${event.stepId}`;
    console.log(`→ processing ${label}`);
    const result = await runtime.process(event, current);
    current = result.state;
    trace = result.trace;
    queue.push(...result.emitted);
  }

  if (current === undefined || trace === undefined) {
    throw new Error("Queue did not produce a run state");
  }

  return { state: current, trace };
}

function printTrace(title: string, trace: RunTrace) {
  console.log(`\n── ${title} ──\n`);

  for (const [id, node] of Object.entries(trace.nodes)) {
    const parts = [`${id}: ${node.status}`];
    if (node.status === "resolved")
      parts.push(`→ ${JSON.stringify(node.value)}`);
    if (node.status === "waiting") parts.push(`waitingOn: ${node.waitingOn}`);
    if (node.status === "blocked") parts.push(`blockedOn: ${node.blockedOn}`);
    if (node.deps.length) parts.push(`deps: [${node.deps.join(", ")}]`);
    if (node.attempts) parts.push(`attempts: ${node.attempts}`);
    console.log(parts.join("  "));
  }
}

console.log("── Running workflow ──");

const firstRun = await drainQueue({
  kind: "input",
  eventId: crypto.randomUUID(),
  runId: "run-1",
  inputId: provider.__id,
  payload: {
    name: "DispatchCo",
    openapiUrl: "https://dispatchco.example/openapi.json",
  },
});

printTrace("Trace After Provider Input", firstRun.trace);

const secondRun = await drainQueue(
  {
    kind: "input",
    eventId: crypto.randomUUID(),
    runId: "run-1",
    inputId: overlayReview.__id,
    payload: {
      approved: true,
      strippedPaths: ["/paths/~1admin", "/components/schemas/InternalOnly"],
    },
  },
  firstRun.state,
);

printTrace("Trace After Overlay Review", secondRun.trace);

const thirdRun = await drainQueue(
  {
    kind: "input",
    eventId: crypto.randomUUID(),
    runId: "run-1",
    inputId: prodApproval.__id,
    payload: {
      approved: true,
      changeTicket: "CHG-4821",
    },
  },
  secondRun.state,
);

printTrace("Final Trace", thirdRun.trace);
