import { describe, it, expect } from "vitest";
import { z } from "zod";
import { input } from "../src/input";
import { atom } from "../src/atom";
import { createRuntime } from "../src/runtime";
import { resetRegistry, runToIdle, assertResolved } from "./helpers";

describe("Example 4 — Parallel dedup", () => {
  resetRegistry();

  it("enriched runs only once despite two dependents", async () => {
    const order = input("order", z.object({
      orderId: z.string(),
      items: z.array(z.string()),
    }));

    let enrichCallCount = 0;

    const enriched = atom(async (get) => {
      const o = get(order);
      enrichCallCount++;
      await new Promise(r => setTimeout(r, 50));
      return { ...o, total: o.items.length * 10 };
    }, { name: "enriched" });

    const notifyWarehouse = atom((get) => {
      const e = get(enriched);
      return `warehouse notified for ${e.orderId}`;
    }, { name: "notifyWarehouse" });

    const sendReceipt = atom((get) => {
      const e = get(enriched);
      return `receipt sent for ${e.orderId}`;
    }, { name: "sendReceipt" });

    const runtime = createRuntime();
    const { trace } = await runToIdle(runtime, {
      kind: "input",
      eventId: "evt-1",
      runId: "run-1",
      inputId: "order",
      payload: { orderId: "ORD-42", items: ["widget", "gadget"] },
    });

    expect(enrichCallCount).toBe(1);
    assertResolved(trace, "enriched", { orderId: "ORD-42", items: ["widget", "gadget"], total: 20 });
    assertResolved(trace, "notifyWarehouse", "warehouse notified for ORD-42");
    assertResolved(trace, "sendReceipt", "receipt sent for ORD-42");
  });
});
