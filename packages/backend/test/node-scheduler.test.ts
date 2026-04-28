import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeploymentSource } from "../src/scheduling/dispatcher";
import { createNodeScheduler } from "../src/scheduling/node";

const noTargets: DeploymentSource = { list: async () => [] };

describe("createNodeScheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("aligns the first tick to the next interval boundary", async () => {
    // 14:30:20 → next minute boundary is 40s away.
    vi.setSystemTime(new Date("2026-04-27T14:30:20.000Z"));

    const sourceCalls = vi.fn(async () => []);
    const scheduler = createNodeScheduler({
      resolveSource: () => ({ list: sourceCalls }),
      fetch: vi.fn(async () => new Response("{}")),
    });

    scheduler.start();

    // 39 seconds elapsed — still before the 40s alignment.
    await vi.advanceTimersByTimeAsync(39_000);
    expect(sourceCalls).toHaveBeenCalledTimes(0);

    // Cross the boundary at exactly 40s.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sourceCalls).toHaveBeenCalledTimes(1);

    // Subsequent ticks fire on every minute.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sourceCalls).toHaveBeenCalledTimes(2);

    scheduler.stop();
  });

  it("does not pile up overlapping ticks when one stalls past the interval", async () => {
    vi.setSystemTime(new Date("2026-04-27T14:30:00.000Z"));

    let inflight = 0;
    let peakInflight = 0;
    let completed = 0;
    const slowList = vi.fn(async () => {
      inflight += 1;
      peakInflight = Math.max(peakInflight, inflight);
      // A tick that takes 3 minutes to dispatch.
      await new Promise((resolve) => setTimeout(resolve, 180_000));
      inflight -= 1;
      completed += 1;
      return [];
    });

    const scheduler = createNodeScheduler({
      resolveSource: () => ({ list: slowList }),
      fetch: vi.fn(async () => new Response("{}")),
    });

    scheduler.start();
    // Run for 5 minutes of wall-clock time.
    await vi.advanceTimersByTimeAsync(60_000); // first tick at boundary
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000); // first tick still going (3min)
    await vi.advanceTimersByTimeAsync(60_000); // first completes here, next can fire
    await vi.advanceTimersByTimeAsync(60_000);

    scheduler.stop();
    await vi.runAllTimersAsync();

    // Without overlap protection we'd have ~5 in-flight at once; with it we
    // never exceed 1, and the second tick only fires after the first finishes.
    expect(peakInflight).toBe(1);
    expect(completed).toBeGreaterThanOrEqual(1);
  });

  it("start() is idempotent and stop() halts further ticks", async () => {
    vi.setSystemTime(new Date("2026-04-27T14:30:00.000Z")); // exact boundary

    const sourceCalls = vi.fn(async () => []);
    const scheduler = createNodeScheduler({
      resolveSource: () => ({ list: sourceCalls }),
      intervalMs: 60_000,
      fetch: vi.fn(async () => new Response("{}")),
    });

    scheduler.start();
    scheduler.start(); // double-start must not double the cadence
    scheduler.start();

    // Boundary alignment at t=0 means msToNext = interval (not 0), so first
    // tick fires after exactly one interval.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sourceCalls).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(sourceCalls).toHaveBeenCalledTimes(2);

    scheduler.stop();

    await vi.advanceTimersByTimeAsync(60_000 * 5);
    expect(sourceCalls).toHaveBeenCalledTimes(2);
  });

  it("routes thrown errors from resolveSource through onError without halting", async () => {
    vi.setSystemTime(new Date("2026-04-27T14:30:00.000Z"));

    const errors: unknown[] = [];
    let firstCall = true;
    const scheduler = createNodeScheduler({
      resolveSource: () => {
        if (firstCall) {
          firstCall = false;
          throw new Error("registry boom");
        }
        return noTargets;
      },
      onError: (err) => errors.push(err),
      fetch: vi.fn(async () => new Response("{}")),
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000); // first tick → throws
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("registry boom");

    // Scheduler keeps running; second tick succeeds.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(errors).toHaveLength(1);

    scheduler.stop();
  });

  it("respects a custom intervalMs", async () => {
    vi.setSystemTime(new Date("2026-04-27T14:30:00.000Z"));
    const sourceCalls = vi.fn(async () => []);

    const scheduler = createNodeScheduler({
      resolveSource: () => ({ list: sourceCalls }),
      intervalMs: 5_000,
      fetch: vi.fn(async () => new Response("{}")),
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sourceCalls).toHaveBeenCalledTimes(3);
    scheduler.stop();
  });
});
