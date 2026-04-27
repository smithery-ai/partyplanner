import { describe, expect, it } from "vitest";
import { z } from "zod";
import { input } from "../src/input";
import { globalRegistry } from "../src/registry";
import { schedule } from "../src/schedule";
import { resetRegistry } from "./helpers";

describe("schedule() primitive", () => {
  resetRegistry();

  it("registers a schedule keyed by id with its input + payload", () => {
    const trigger = input("nightlySweep", z.object({ region: z.string() }));

    schedule("nightly-us", "0 3 * * *", {
      trigger,
      payload: { region: "us-east-1" },
      description: "Nightly US sweep",
    });

    const all = globalRegistry.allSchedules();
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual({
      id: "nightly-us",
      cron: "0 3 * * *",
      inputId: "nightlySweep",
      payload: { region: "us-east-1" },
      description: "Nightly US sweep",
    });
  });

  it("rejects schedules whose trigger input was never registered", () => {
    const fake = { __id: "ghostInput", __kind: "input" as const } as Parameters<
      typeof schedule
    >[2]["trigger"];

    expect(() =>
      schedule("ghost", "* * * * *", { trigger: fake, payload: {} }),
    ).toThrow(/unknown input "ghostInput"/);
  });

  it("rejects duplicate schedule ids", () => {
    const trigger = input("dupTrigger", z.object({}));
    schedule("dup", "* * * * *", { trigger, payload: {} });

    expect(() =>
      schedule("dup", "*/5 * * * *", { trigger, payload: {} }),
    ).toThrow(/Duplicate registry ID: dup/);
  });

  it("schedule ids share the input/atom/action namespace", () => {
    const trigger = input("collide", z.object({}));
    expect(() =>
      schedule("collide", "* * * * *", { trigger, payload: {} }),
    ).toThrow(/Duplicate registry ID: collide/);
  });

  it("clear() drops registered schedules", () => {
    const trigger = input("once", z.object({}));
    schedule("clearMe", "* * * * *", { trigger, payload: {} });
    expect(globalRegistry.allSchedules()).toHaveLength(1);

    globalRegistry.clear();
    expect(globalRegistry.allSchedules()).toHaveLength(0);
  });
});
