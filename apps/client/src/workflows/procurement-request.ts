import { atom, input } from "@workflow/core";
import { z } from "zod";

export const request = input(
  "request",
  z.object({
    requester: z.string(),
    item: z.string(),
    category: z.enum(["software", "hardware", "services"]).default("software"),
    amountUsd: z.number(),
    soleSource: z.boolean().default(false),
  }),
  { description: "Internal procurement request." },
);

export const securityReview = input.deferred(
  "securityReview",
  z.object({
    approved: z.boolean(),
    riskNote: z.string().optional(),
  }),
  { description: "Security review for software and services purchases." },
);

export const budgetApproval = input.deferred(
  "budgetApproval",
  z.object({
    approved: z.boolean(),
    costCenter: z.string(),
  }),
  { description: "Budget approval for larger purchases." },
);

export const routeRequest = atom(
  (get) => {
    const r = get(request);
    return {
      needsSecurity: r.category !== "hardware",
      needsBudget: r.amountUsd >= 1000 || r.soleSource,
      lane: r.amountUsd >= 10000 ? "strategic" : "standard",
    };
  },
  { name: "routeRequest" },
);

export const approveSecurity = atom(
  (get) => {
    const route = get(routeRequest);
    if (!route.needsSecurity) return get.skip("Security review not required.");
    const review = get(securityReview);
    if (!review.approved) return get.skip("Security rejected the request.");
    return review;
  },
  { name: "approveSecurity" },
);

export const approveBudget = atom(
  (get) => {
    const route = get(routeRequest);
    if (!route.needsBudget) return { approved: true, costCenter: "auto" };
    const approval = get(budgetApproval);
    if (!approval.approved) return get.skip("Budget approval rejected.");
    return approval;
  },
  { name: "approveBudget" },
);

export const issuePurchaseOrder = atom(
  (get) => {
    const r = get(request);
    return {
      requester: r.requester,
      item: r.item,
      route: get(routeRequest),
      security: get.maybe(approveSecurity),
      budget: get(approveBudget),
    };
  },
  { name: "issuePurchaseOrder" },
);
