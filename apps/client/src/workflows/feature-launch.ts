import { atom, input } from "@workflow/core";
import { z } from "zod";

export const launchPlan = input(
  "launchPlan",
  z.object({
    feature: z.string(),
    owner: z.string(),
    risk: z.enum(["low", "medium", "high"]).default("medium"),
    docsReady: z.boolean().default(false),
    flagName: z.string(),
  }),
  { description: "Feature launch plan." },
);

export const goNoGo = input.deferred(
  "goNoGo",
  z.object({
    approved: z.boolean(),
    rolloutPercent: z.number().default(10),
  }),
  { description: "Go/no-go decision from launch review." },
);

export const readiness = atom(
  (get) => {
    const plan = get(launchPlan);
    return {
      docsReady: plan.docsReady,
      needsReview: plan.risk !== "low",
      owner: plan.owner,
    };
  },
  { name: "readiness" },
);

export const prepareComms = atom(
  (get) => {
    const plan = get(launchPlan);
    if (!plan.docsReady) return get.skip("Docs are not ready.");
    return {
      announcement: `${plan.feature} is ready for rollout`,
      owner: plan.owner,
    };
  },
  { name: "prepareComms" },
);

export const enableFlag = atom(
  (get) => {
    const plan = get(launchPlan);
    const ready = get(readiness);
    if (ready.needsReview) {
      const decision = get(goNoGo);
      if (!decision.approved) return get.skip("Launch review blocked rollout.");
      return {
        flag: plan.flagName,
        rolloutPercent: decision.rolloutPercent,
      };
    }
    return { flag: plan.flagName, rolloutPercent: 100 };
  },
  { name: "enableFlag" },
);

export const launchSummary = atom(
  (get) => ({
    flag: get(enableFlag),
    comms: get.maybe(prepareComms),
  }),
  { name: "launchSummary" },
);
