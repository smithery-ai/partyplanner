import { atom, input } from "@workflow/core";
import { z } from "zod";

export const lead = input(
  "lead",
  z.object({
    name: z.string(),
    plan: z.enum(["starter", "enterprise"]),
  }),
  { description: "A signup or sales lead entering the workflow." },
);

export const approval = input.deferred(
  "approval",
  z.object({
    approved: z.boolean(),
    note: z.string().optional(),
  }),
  { description: "Manual approval for enterprise onboarding." },
);

export const qualify = atom(
  (get) => {
    const value = get(lead);
    return value.plan === "enterprise" ? "needs-approval" : "self-serve";
  },
  { name: "qualify" },
);

export const provision = atom(
  (get) => {
    const value = get(lead);
    const route = get(qualify);
    if (route === "self-serve") {
      return {
        action: "provision",
        account: value.name,
        tier: "starter",
      };
    }

    const decision = get(approval);
    if (!decision.approved) return get.skip(decision.note ?? "Not approved");

    return {
      action: "provision",
      account: value.name,
      tier: "enterprise",
    };
  },
  { name: "provision" },
);
