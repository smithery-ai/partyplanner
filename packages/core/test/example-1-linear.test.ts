import { describe, expect, it } from "vitest";
import { z } from "zod";
import { atom } from "../src/atom";
import { input } from "../src/input";
import { createRuntime } from "../src/runtime";
import { assertResolved, resetRegistry, runToIdle } from "./helpers";

describe("Example 1 — Simple linear pipeline", () => {
  resetRegistry();

  it("resolves all three nodes on a single input event", async () => {
    const slack = input(
      "slack",
      z.object({
        message: z.string(),
        channel: z.string(),
      }),
    );

    const classify = atom(
      (get) => {
        const msg = get(slack);
        return msg.message.toLowerCase().includes("urgent")
          ? "urgent"
          : "normal";
      },
      { name: "classify" },
    );

    const _format = atom(
      (get) => {
        const priority = get(classify);
        const msg = get(slack);
        return `[${priority.toUpperCase()}] ${msg.channel}: ${msg.message}`;
      },
      { name: "format" },
    );

    const runtime = createRuntime();
    const { trace } = await runToIdle(runtime, {
      kind: "input",
      eventId: "evt-1",
      runId: "run-1",
      inputId: "slack",
      payload: { message: "Server is down URGENT", channel: "#ops" },
    });

    assertResolved(trace, "slack", {
      message: "Server is down URGENT",
      channel: "#ops",
    });
    assertResolved(trace, "classify", "urgent");
    assertResolved(trace, "format", "[URGENT] #ops: Server is down URGENT");

    // format depends on both classify and slack
    expect(trace.nodes.format.deps).toContain("classify");
    expect(trace.nodes.format.deps).toContain("slack");
  });
});
