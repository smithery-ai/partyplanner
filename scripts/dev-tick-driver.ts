#!/usr/bin/env node
// Live test driver for the schedule abstraction. Runs createNodeScheduler
// pointed at a hardcoded list of workflow URLs (the local Next.js example by
// default), so we can verify ticks land on minute boundaries and trigger the
// expected schedules. No Postgres, no deployment registry — just the
// dispatcher → /schedules/tick contract.
//
// Usage:
//   HYLO_SCHEDULE_PROBE=1 pnpm -C examples/nextjs dev   # in one shell
//   pnpm tsx scripts/dev-tick-driver.ts                 # in another
//
// Env:
//   WORKFLOW_URLS  comma-separated workflow base URLs
//                  (default: http://localhost:3000/api/workflow)
//   INTERVAL_MS    tick cadence (default 60000)

import { createNodeScheduler } from "../packages/backend/src/scheduling/node";

const workflowUrls = (
  process.env.WORKFLOW_URLS ?? "http://localhost:3000/api/workflow"
)
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean);

const intervalMs = Number(process.env.INTERVAL_MS ?? 60_000);

const targets = workflowUrls.map((workflowApiUrl, i) => ({
  deploymentId: `local-${i}`,
  workflowApiUrl,
}));

const scheduler = createNodeScheduler({
  intervalMs,
  resolveSource: () => ({ list: async () => targets }),
  onTick: (result) => {
    const stamp = new Date().toISOString();
    console.log(
      `[${stamp}] tick at=${result.at} attempted=${result.attempted} ok=${result.ok} failed=${result.failed}`,
    );
  },
  onError: (error) => {
    console.error(
      "[tick-driver] error:",
      error instanceof Error ? error.message : String(error),
    );
  },
});

console.log(
  `[tick-driver] starting — interval ${intervalMs}ms, targets:`,
  workflowUrls,
);
scheduler.start();

const shutdown = (signal: NodeJS.Signals) => {
  console.log(`[tick-driver] received ${signal}, stopping`);
  scheduler.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
