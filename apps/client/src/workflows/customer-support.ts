import { atom, input } from "@workflow/core";
import { z } from "zod";

export const ticket = input(
  "ticket",
  z.object({
    customer: z.string().describe("Customer or account name."),
    subject: z.string().describe("Short issue summary."),
    severity: z
      .enum(["low", "medium", "high", "critical"])
      .default("medium")
      .describe("Reported business impact."),
    plan: z.enum(["free", "team", "enterprise"]).default("team"),
    hasRepro: z.boolean().default(false),
  }),
  { description: "Incoming customer support ticket." },
);

export const managerReview = input.deferred(
  "managerReview",
  z.object({
    approved: z.boolean().describe("Approval for priority escalation."),
    note: z.string().optional().describe("Internal manager note."),
  }),
  { description: "Manager review for urgent or enterprise tickets." },
);

export const classify = atom(
  (get) => {
    const t = get(ticket);
    if (t.severity === "critical") return "incident";
    if (t.plan === "enterprise" && t.severity === "high") return "priority";
    if (!t.hasRepro) return "needs-repro";
    return "standard";
  },
  { name: "classify", description: "Classify the support ticket." },
);

export const draftReply = atom(
  (get) => {
    const t = get(ticket);
    const kind = get(classify);
    return {
      customer: t.customer,
      subject: t.subject,
      template:
        kind === "needs-repro"
          ? "request-reproduction"
          : kind === "incident"
            ? "incident-acknowledgement"
            : "standard-support-reply",
    };
  },
  { name: "draftReply" },
);

export const escalate = atom(
  (get) => {
    const kind = get(classify);
    if (kind !== "incident" && kind !== "priority") {
      return get.skip("Escalation is not required.");
    }
    const review = get(managerReview);
    if (!review.approved)
      return get.skip("Manager did not approve escalation.");
    const t = get(ticket);
    return {
      queue: kind === "incident" ? "incident-command" : "priority-support",
      customer: t.customer,
      note: review.note,
    };
  },
  { name: "escalate" },
);

export const closeLoop = atom(
  (get) => {
    const reply = get(draftReply);
    const escalation = get.maybe(escalate);
    return {
      reply,
      escalation,
      nextAction: escalation ? "page-owner" : "send-reply",
    };
  },
  { name: "closeLoop" },
);
