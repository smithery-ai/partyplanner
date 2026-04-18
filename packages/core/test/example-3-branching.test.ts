import { describe, it } from "vitest";
import { z } from "zod";
import { input } from "../src/input";
import { atom } from "../src/atom";
import { createRuntime } from "../src/runtime";
import { resetRegistry, runToIdle, assertResolved, assertSkipped } from "./helpers";

describe("Example 3 — Branching with skip propagation", () => {
  resetRegistry();

  it("github input resolves code review branch, skips echo", async () => {
    const github = input("github", z.object({ repo: z.string(), diff: z.string() }));
    const slack = input("slack", z.object({ message: z.string() }));

    const codeReview = atom((get) => {
      const pr = get(github);
      return { suggestions: pr.diff.split("\n").length };
    }, { name: "codeReview" });

    const postReview = atom((get) => {
      const review = get(codeReview);
      return `Posted review with ${review.suggestions} suggestions`;
    }, { name: "postReview" });

    const echo = atom((get) => {
      const msg = get(slack);
      return `echo: ${msg.message}`;
    }, { name: "echo" });

    const runtime = createRuntime();
    const { trace } = await runToIdle(runtime, {
      kind: "input",
      eventId: "evt-1",
      runId: "run-1",
      inputId: "github",
      payload: { repo: "acme/app", diff: "line1\nline2\nline3" },
    });

    assertResolved(trace, "codeReview", { suggestions: 3 });
    assertResolved(trace, "postReview", "Posted review with 3 suggestions");
    assertSkipped(trace, "echo");
    assertSkipped(trace, "slack");
  });

  it("slack input resolves echo, skips code review branch", async () => {
    const github = input("github", z.object({ repo: z.string(), diff: z.string() }));
    const slack = input("slack", z.object({ message: z.string() }));

    const codeReview = atom((get) => {
      const pr = get(github);
      return { suggestions: pr.diff.split("\n").length };
    }, { name: "codeReview" });

    const postReview = atom((get) => {
      const review = get(codeReview);
      return `Posted review with ${review.suggestions} suggestions`;
    }, { name: "postReview" });

    const echo = atom((get) => {
      const msg = get(slack);
      return `echo: ${msg.message}`;
    }, { name: "echo" });

    const runtime = createRuntime();
    const { trace } = await runToIdle(runtime, {
      kind: "input",
      eventId: "evt-2",
      runId: "run-2",
      inputId: "slack",
      payload: { message: "hello there" },
    });

    assertResolved(trace, "echo", "echo: hello there");
    assertSkipped(trace, "github");
    assertSkipped(trace, "codeReview");
    assertSkipped(trace, "postReview");
  });
});
