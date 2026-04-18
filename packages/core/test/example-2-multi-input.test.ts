import { describe, it } from "vitest";
import { z } from "zod";
import { input } from "../src/input";
import { atom } from "../src/atom";
import { createRuntime } from "../src/runtime";
import { resetRegistry, runToIdle, assertResolved, assertSkipped } from "./helpers";

describe("Example 2 — Multi-input with get.maybe", () => {
  resetRegistry();

  it("resolves via slack input", async () => {
    const slack = input("slack", z.object({ text: z.string() }));
    const email = input("email", z.object({ body: z.string() }));

    const extractText = atom((get) => {
      const s = get.maybe(slack);
      const e = get.maybe(email);
      return s?.text ?? e?.body ?? get.skip();
    }, { name: "extractText" });

    const wordCount = atom((get) => {
      const text = get(extractText);
      return text.split(/\s+/).length;
    }, { name: "wordCount" });

    const runtime = createRuntime();
    const { trace } = await runToIdle(runtime, {
      kind: "input",
      eventId: "evt-1",
      runId: "run-1",
      inputId: "slack",
      payload: { text: "hello world foo" },
    });

    assertResolved(trace, "slack", { text: "hello world foo" });
    assertSkipped(trace, "email");
    assertResolved(trace, "extractText", "hello world foo");
    assertResolved(trace, "wordCount", 3);
  });

  it("resolves via email input", async () => {
    const slack = input("slack", z.object({ text: z.string() }));
    const email = input("email", z.object({ body: z.string() }));

    const extractText = atom((get) => {
      const s = get.maybe(slack);
      const e = get.maybe(email);
      return s?.text ?? e?.body ?? get.skip();
    }, { name: "extractText" });

    const wordCount = atom((get) => {
      const text = get(extractText);
      return text.split(/\s+/).length;
    }, { name: "wordCount" });

    const runtime = createRuntime();
    const { trace } = await runToIdle(runtime, {
      kind: "input",
      eventId: "evt-2",
      runId: "run-2",
      inputId: "email",
      payload: { body: "one two three four" },
    });

    assertResolved(trace, "email", { body: "one two three four" });
    assertSkipped(trace, "slack");
    assertResolved(trace, "extractText", "one two three four");
    assertResolved(trace, "wordCount", 4);
  });
});
