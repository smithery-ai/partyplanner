import { describe, expect, it } from "vitest";
import { z } from "zod";
import { action } from "../src/action";
import { atom } from "../src/atom";
import { input } from "../src/input";
import { createRuntime } from "../src/runtime";
import { assertResolved, resetRegistry, runToIdle } from "./helpers";

describe("action() primitive", () => {
  resetRegistry();

  it("is pull-only: not fanned out by input events", async () => {
    const _trigger = input("trigger", z.object({ x: z.number() }));

    let actionRan = false;
    const _writeSomething = action(
      () => {
        actionRan = true;
        return { ok: true };
      },
      { name: "writeSomething" },
    );

    const runtime = createRuntime();
    const { trace } = await runToIdle(runtime, {
      kind: "input",
      eventId: "e-1",
      runId: "r-1",
      inputId: "trigger",
      payload: { x: 1 },
    });

    expect(actionRan).toBe(false);
    expect(trace.nodes.writeSomething.status).toBe("not_reached");
    expect(trace.nodes.writeSomething.kind).toBe("action");
  });

  it("executes when a downstream atom reads it via get()", async () => {
    const trigger = input("trigger", z.object({ name: z.string() }));

    let runs = 0;
    const createPlaylist = action(
      (get) => {
        runs++;
        const t = get(trigger);
        return { playlistId: `pl_${t.name}` };
      },
      { name: "createPlaylist" },
    );

    const _consumer = atom(
      (get) => {
        const { playlistId } = get(createPlaylist);
        return `made ${playlistId}`;
      },
      { name: "consumer" },
    );

    const runtime = createRuntime();
    const { trace } = await runToIdle(runtime, {
      kind: "input",
      eventId: "e-1",
      runId: "r-1",
      inputId: "trigger",
      payload: { name: "chill" },
    });

    expect(runs).toBe(1);
    assertResolved(trace, "createPlaylist", { playlistId: "pl_chill" });
    assertResolved(trace, "consumer", "made pl_chill");
    expect(trace.nodes.createPlaylist.kind).toBe("action");
    expect(trace.nodes.consumer.kind).toBe("atom");
  });

  it("is non-idempotent across event replay: resolved actions don't re-execute", async () => {
    const trigger = input("trigger", z.object({ n: z.number() }));

    let runs = 0;
    const sendEmail = action(
      (get) => {
        runs++;
        const { n } = get(trigger);
        return { sent: n };
      },
      { name: "sendEmail" },
    );

    const _consumer = atom(
      (get) => {
        const r = get(sendEmail);
        return `ok:${r.sent}`;
      },
      { name: "consumer" },
    );

    const runtime = createRuntime();
    const first = await runToIdle(runtime, {
      kind: "input",
      eventId: "e-1",
      runId: "r-1",
      inputId: "trigger",
      payload: { n: 7 },
    });
    expect(runs).toBe(1);

    // Replay another input event on the same run state. The action should not re-fire.
    const second = await runToIdle(
      runtime,
      {
        kind: "input",
        eventId: "e-2",
        runId: "r-1",
        inputId: "trigger",
        payload: { n: 99 },
      },
      first.state,
    );

    expect(runs).toBe(1);
    assertResolved(second.trace, "sendEmail", { sent: 7 });
  });

  it("allows actions to depend on atoms", async () => {
    const trigger = input("trigger", z.object({ base: z.string() }));

    const computeName = atom(
      (get) => {
        const { base } = get(trigger);
        return `${base}-derived`;
      },
      { name: "computeName" },
    );

    const writeIt = action(
      (get) => {
        const name = get(computeName);
        return { wrote: name };
      },
      { name: "writeIt" },
    );

    const _consumer = atom(
      (get) => {
        return get(writeIt).wrote;
      },
      { name: "consumer" },
    );

    const runtime = createRuntime();
    const { trace } = await runToIdle(runtime, {
      kind: "input",
      eventId: "e-1",
      runId: "r-1",
      inputId: "trigger",
      payload: { base: "hello" },
    });

    assertResolved(trace, "computeName", "hello-derived");
    assertResolved(trace, "writeIt", { wrote: "hello-derived" });
    assertResolved(trace, "consumer", "hello-derived");
  });
});
