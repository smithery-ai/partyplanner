import { atom, input, secret } from "@workflow/core";
import { z } from "zod";

export const lead = input(
  "lead",
  z.object({
    company: z.string(),
    employeeCount: z.number(),
    budgetUsd: z.number(),
    urgency: z.enum(["this-month", "this-quarter", "later"]).default("later"),
    requestedDemo: z.boolean().default(false),
  }),
  { description: "Inbound sales lead." },
);

export const aeReview = input.deferred(
  "aeReview",
  z.object({
    accepted: z.boolean(),
    owner: z.string().describe("Account executive owner."),
  }),
  { description: "AE acceptance for qualified opportunities." },
);

export const crmApiKey = secret("CRM_API_KEY", {
  description: "CRM API key used to create opportunity and nurture records.",
});

export const calendarApiKey = secret("CALENDAR_API_KEY", {
  description: "Calendar API key used to schedule accepted demos.",
});

export const scoreLead = atom(
  (get) => {
    const l = get(lead);
    let score = 0;
    if (l.employeeCount >= 500) score += 35;
    if (l.budgetUsd >= 50000) score += 35;
    if (l.urgency === "this-month") score += 20;
    if (l.requestedDemo) score += 10;
    return score;
  },
  { name: "scoreLead" },
);

export const routeLead = atom(
  (get) => {
    const score = get(scoreLead);
    const l = get(lead);
    if (score >= 70) return { lane: "enterprise", company: l.company };
    if (score >= 40) return { lane: "commercial", company: l.company };
    return { lane: "nurture", company: l.company };
  },
  { name: "routeLead" },
);

export const scheduleDemo = atom(
  (get) => {
    const route = get(routeLead);
    if (route.lane === "nurture") return get.skip("Lead is not sales-ready.");
    const review = get(aeReview);
    if (!review.accepted) return get.skip("AE did not accept the lead.");
    const calendarKey = get(calendarApiKey);
    return {
      company: route.company,
      owner: review.owner,
      calendar: route.lane === "enterprise" ? "exec-demo" : "standard-demo",
      credential: calendarKey.length > 0 ? "CALENDAR_API_KEY" : undefined,
    };
  },
  { name: "scheduleDemo" },
);

export const nurture = atom(
  (get) => {
    const route = get(routeLead);
    if (route.lane !== "nurture") return get.skip("Lead is sales-ready.");
    const crmKey = get(crmApiKey);
    return {
      company: route.company,
      campaign: "product-education",
      credential: crmKey.length > 0 ? "CRM_API_KEY" : undefined,
    };
  },
  { name: "nurture" },
);
