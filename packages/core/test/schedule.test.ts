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
    const fake = {
      __id: "ghostInput",
      __kind: "input" as const,
    } as Parameters<typeof schedule<object>>[2] extends infer Opts
      ? Opts extends { trigger: infer T }
        ? T
        : never
      : never;

    expect(() =>
      schedule("ghost", "* * * * *", { trigger: fake, payload: {} }),
    ).toThrow(/unknown input "ghostInput"/);
  });

  it("schema form auto-creates a hidden internal input", () => {
    const probeSchema = z.object({ label: z.string() });

    schedule("probe-1m", "* * * * *", {
      schema: probeSchema,
      payload: { label: "every-minute" },
      description: "Schedule-only probe.",
    });

    const inputs = globalRegistry.allInputs();
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      id: "__schedule_probe-1m",
      kind: "input",
      internal: true,
    });

    const schedules = globalRegistry.allSchedules();
    expect(schedules).toHaveLength(1);
    expect(schedules[0]).toMatchObject({
      id: "probe-1m",
      cron: "* * * * *",
      inputId: "__schedule_probe-1m",
      payload: { label: "every-minute" },
    });
  });

  it("two schema-form schedules each get their own hidden input", () => {
    const probeSchema = z.object({ region: z.string() });

    schedule("us-probe", "*/5 * * * *", {
      schema: probeSchema,
      payload: { region: "us" },
    });
    schedule("eu-probe", "*/5 * * * *", {
      schema: probeSchema,
      payload: { region: "eu" },
    });

    const inputs = globalRegistry.allInputs().map((i) => i.id);
    expect(inputs).toEqual(["__schedule_us-probe", "__schedule_eu-probe"]);
    expect(globalRegistry.allSchedules()).toHaveLength(2);
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
