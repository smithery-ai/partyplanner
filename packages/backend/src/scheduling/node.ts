import {
  type DeploymentSource,
  type DispatchFetch,
  type DispatchTickResult,
  dispatchTickToDeployments,
} from "./dispatcher";

export type NodeSchedulerOptions = {
  resolveSource: () => DeploymentSource | Promise<DeploymentSource>;
  // Tick interval in ms. Defaults to 60_000 to match Cloudflare's
  // minute-granularity cron triggers.
  intervalMs?: number;
  fetch?: DispatchFetch;
  onTick?: (result: DispatchTickResult) => void;
  onError?: (error: unknown) => void;
};

export type NodeScheduler = {
  start(): void;
  stop(): void;
};

// In-process tick driver for Node hosts. Plays the same role as the
// Cloudflare `scheduled()` handler in apps/backend-cloudflare: invoke
// dispatchTickToDeployments() at a fixed cadence so each tenant's
// /schedules/tick endpoint evaluates its own cron expressions.
//
// Semantics matched against Cloudflare:
//   - At-most-once-per-minute. If the process is restarting at the boundary,
//     that minute is dropped (no catch-up replay).
//   - Tick-time aligned to the wall clock so cron expressions like */15 fire
//     at :00/:15/:30/:45 rather than at boot+60s offsets.
//   - Overlapping ticks are dropped (single inflight at a time). This is
//     stricter than CF — which can run two scheduled() invocations
//     concurrently — but prevents unbounded pile-up if a tick stalls.
//
// Single-process assumption: if multiple Node instances share a deployment
// registry, every instance ticks. Use the `enabled` env-flag guard at the
// caller, an external scheduler hitting /schedules/tick directly, or a
// Postgres advisory lock around resolveSource() to elect a single leader.
export function createNodeScheduler(
  options: NodeSchedulerOptions,
): NodeScheduler {
  const interval = options.intervalMs ?? 60_000;
  let initialTimer: ReturnType<typeof setTimeout> | undefined;
  let recurringTimer: ReturnType<typeof setInterval> | undefined;
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const source = await options.resolveSource();
      const result = await dispatchTickToDeployments(
        {
          source,
          fetch: options.fetch,
          onError: (error) => options.onError?.(error),
        },
        new Date(),
      );
      options.onTick?.(result);
    } catch (error) {
      options.onError?.(error);
    } finally {
      running = false;
    }
  };

  return {
    start() {
      if (initialTimer || recurringTimer) return;
      const msToNextBoundary = interval - (Date.now() % interval);
      initialTimer = setTimeout(() => {
        initialTimer = undefined;
        void tick();
        recurringTimer = setInterval(() => void tick(), interval);
      }, msToNextBoundary);
    },
    stop() {
      if (initialTimer) {
        clearTimeout(initialTimer);
        initialTimer = undefined;
      }
      if (recurringTimer) {
        clearInterval(recurringTimer);
        recurringTimer = undefined;
      }
    },
  };
}
