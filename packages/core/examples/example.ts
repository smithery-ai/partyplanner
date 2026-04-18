import { z } from "zod";
import { input, atom, createRuntime } from "../src/index";
import { globalRegistry } from "../src/registry";
import type { QueueEvent, RunState, RunTrace } from "../src/types";

// ── Define a workflow ────────────────────────────────────────────

const slack = input("slack", z.object({
  message: z.string(),
  channel: z.string(),
}));

const classify = atom((get) => {
  const msg = get(slack);
  return msg.message.toLowerCase().includes("urgent") ? "urgent" : "normal";
}, { name: "classify" });

const format = atom((get) => {
  const priority = get(classify);
  const msg = get(slack);
  return `[${priority.toUpperCase()}] ${msg.channel}: ${msg.message}`;
}, { name: "format" });

// ── Run it ───────────────────────────────────────────────────────

const runtime = createRuntime({
  onStepResolved: (ev) => console.log(`  ✓ ${ev.id} resolved (${ev.duration_ms}ms)`),
  onStepSkipped: (ev) => console.log(`  ⊘ ${ev.id} skipped`),
  onStepBlocked: (ev) => console.log(`  ⏳ ${ev.id} blocked on ${ev.blockedOn}`),
  onStepWaiting: (ev) => console.log(`  ⏸ ${ev.id} waiting on ${ev.waitingOn}`),
  onStepErrored: (ev) => console.log(`  ✗ ${ev.id} errored: ${ev.error.message}`),
});

async function drainQueue(seed: QueueEvent, state?: RunState) {
  const queue = [seed];
  let current = state;
  let trace!: RunTrace;

  while (queue.length > 0) {
    const event = queue.shift()!;
    const label = event.kind === "input" ? `input:${event.inputId}` : `step:${event.stepId}`;
    console.log(`→ processing ${label}`);
    const result = await runtime.process(event, current);
    current = result.state;
    trace = result.trace;
    queue.push(...result.emitted);
  }

  return { state: current!, trace };
}

console.log("── Running workflow ──\n");

const { trace } = await drainQueue({
  kind: "input",
  eventId: crypto.randomUUID(),
  runId: "run-1",
  inputId: "slack",
  payload: { message: "Server is down URGENT", channel: "#ops" },
});

console.log("\n── Trace ──\n");

for (const [id, node] of Object.entries(trace.nodes)) {
  const parts = [`${id}: ${node.status}`];
  if (node.status === "resolved") parts.push(`→ ${JSON.stringify(node.value)}`);
  if (node.deps.length) parts.push(`deps: [${node.deps.join(", ")}]`);
  if (node.attempts) parts.push(`attempts: ${node.attempts}`);
  console.log(parts.join("  "));
}
