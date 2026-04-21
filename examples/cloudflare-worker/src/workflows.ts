import { atom, input, secret } from "@workflow/core";
import { z } from "zod";

declare global {
  var __workflowExampleSecrets: Record<string, string> | undefined;
}

function exampleSecretValue(name: string): string {
  globalThis.__workflowExampleSecrets ??= {};
  const cache = globalThis.__workflowExampleSecrets;
  cache[name] ??= `dev-${name.toLowerCase()}-${randomId()}`;
  return cache[name];
}

function randomId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)
  );
}

export const incidentAlert = input(
  "incidentAlert",
  z.object({
    service: z.string().default("checkout-api"),
    severity: z.enum(["sev1", "sev2", "sev3"]).default("sev2"),
    customerImpact: z
      .string()
      .default("Elevated payment failures for enterprise customers."),
    detectedBy: z
      .enum(["synthetic", "support", "engineer"])
      .default("synthetic"),
  }),
  {
    title: "Respond to an incident",
    description:
      "Start the incident response workflow for a production service issue.",
  },
);

export const purchaseRequest = input(
  "purchaseRequest",
  z.object({
    requester: z.string().default("Maya Chen"),
    vendor: z.string().default("Vector Labs"),
    amountUsd: z.number().default(4800),
    category: z.enum(["software", "hardware", "services"]).default("software"),
    justification: z
      .string()
      .default("Annual observability renewal for production systems."),
  }),
  {
    title: "Review a purchase request",
    description:
      "Start the procurement workflow for a vendor purchase request.",
  },
);

export const customerEscalation = input(
  "customerEscalation",
  z.object({
    account: z.string().default("Northstar Bank"),
    tier: z.enum(["standard", "enterprise", "strategic"]).default("enterprise"),
    issue: z.string().default("Data export job has been stuck for six hours."),
    sentiment: z.enum(["calm", "frustrated", "angry"]).default("frustrated"),
  }),
  {
    title: "Handle a customer escalation",
    description:
      "Start the customer escalation workflow for a support or success team.",
  },
);

export const incidentCommsApproval = input.deferred(
  "incidentCommsApproval",
  z.object({
    approved: z.boolean().default(true),
    channel: z.enum(["status-page", "email", "slack"]).default("status-page"),
    note: z.string().optional(),
  }),
  {
    title: "Approve incident communications",
    description:
      "Human approval for the incident communication before publishing.",
  },
);

export const purchaseApproval = input.deferred(
  "purchaseApproval",
  z.object({
    approved: z.boolean().default(true),
    approver: z.string().default("Finance Lead"),
    costCenter: z.string().default("ENG-INFRA"),
    note: z.string().optional(),
  }),
  {
    title: "Approve the purchase",
    description:
      "Finance approval for requests above the self-serve purchase limit.",
  },
);

export const customerResolutionReview = input.deferred(
  "customerResolutionReview",
  z.object({
    approved: z.boolean().default(true),
    creditUsd: z.number().default(500),
    note: z.string().optional(),
  }),
  {
    title: "Review the customer response",
    description:
      "Customer success approval for the proposed response and account credit.",
  },
);

export const pagerDutyToken = secret(
  "PAGER_DUTY_TOKEN",
  exampleSecretValue("PAGER_DUTY_TOKEN"),
  {
    description: "Token used to page the incident commander.",
    errorMessage:
      "Set PAGER_DUTY_TOKEN as a Cloudflare Worker secret before running this workflow.",
  },
);

export const financeApiToken = secret(
  "FINANCE_API_TOKEN",
  exampleSecretValue("FINANCE_API_TOKEN"),
  {
    description: "Token used to create purchase orders in the finance system.",
    errorMessage:
      "Set FINANCE_API_TOKEN as a Cloudflare Worker secret before running this workflow.",
  },
);

export const crmAccessToken = secret(
  "CRM_ACCESS_TOKEN",
  exampleSecretValue("CRM_ACCESS_TOKEN"),
  {
    description: "Token used to read and update customer records in the CRM.",
    errorMessage:
      "Set CRM_ACCESS_TOKEN as a Cloudflare Worker secret before running this workflow.",
  },
);

export const incidentTriage = atom(
  (get) => {
    const alert = get.maybe(incidentAlert);
    if (!alert) return get.skip("No incident alert was submitted");

    const token = get(pagerDutyToken);
    return {
      workflow: "incident",
      action: "page-incident-commander",
      service: alert.service,
      severity: alert.severity,
      detectedBy: alert.detectedBy,
      impact: alert.customerImpact,
      tokenPreview: `${token.slice(0, 4)}...`,
      requiresCommsApproval: alert.severity !== "sev3",
    };
  },
  {
    name: "incidentTriage",
    description: "Classify an incident and page the commander.",
  },
);

export const incidentStatusUpdate = atom(
  (get) => {
    const triage = get(incidentTriage);
    if (!triage.requiresCommsApproval) {
      return {
        workflow: "incident",
        action: "internal-update-only",
        service: triage.service,
      };
    }

    const approval = get(incidentCommsApproval);
    if (!approval.approved) return get.skip(approval.note ?? "Comms rejected");

    return {
      workflow: "incident",
      action: "publish-status-update",
      channel: approval.channel,
      service: triage.service,
      severity: triage.severity,
      message: approval.note ?? triage.impact,
    };
  },
  {
    name: "incidentStatusUpdate",
    description: "Wait for approval, then publish incident communications.",
  },
);

export const incidentWrapUp = atom(
  (get) => {
    const triage = get(incidentTriage);
    const update = get(incidentStatusUpdate);
    return {
      workflow: "incident",
      action: "open-postmortem",
      service: triage.service,
      commsAction: update.action,
    };
  },
  {
    name: "incidentWrapUp",
    description: "Open follow-up work after the incident branch completes.",
  },
);

export const purchasePolicyCheck = atom(
  (get) => {
    const request = get.maybe(purchaseRequest);
    if (!request) return get.skip("No purchase request was submitted");

    const amountUsd = request.amountUsd ?? 0;
    return {
      workflow: "procurement",
      vendor: request.vendor,
      amountUsd,
      requester: request.requester,
      needsApproval: amountUsd >= 1000,
      category: request.category,
      justification: request.justification,
    };
  },
  {
    name: "purchasePolicyCheck",
    description: "Classify the purchase request and decide approval policy.",
  },
);

export const purchaseOrder = atom(
  (get) => {
    const policy = get(purchasePolicyCheck);
    const token = get(financeApiToken);

    if (policy.needsApproval) {
      const approval = get(purchaseApproval);
      if (!approval.approved) {
        return get.skip(approval.note ?? "Purchase was not approved");
      }
      return {
        workflow: "procurement",
        action: "create-approved-purchase-order",
        vendor: policy.vendor,
        amountUsd: policy.amountUsd,
        approver: approval.approver,
        costCenter: approval.costCenter,
        tokenPreview: `${token.slice(0, 4)}...`,
      };
    }

    return {
      workflow: "procurement",
      action: "create-self-serve-purchase-order",
      vendor: policy.vendor,
      amountUsd: policy.amountUsd,
      costCenter: "TEAM-SELF-SERVE",
      tokenPreview: `${token.slice(0, 4)}...`,
    };
  },
  {
    name: "purchaseOrder",
    description:
      "Use finance credentials and optional approval to create the purchase order.",
  },
);

export const purchaseNotifyRequester = atom(
  (get) => {
    const policy = get(purchasePolicyCheck);
    const order = get(purchaseOrder);
    return {
      workflow: "procurement",
      action: "notify-requester",
      requester: policy.requester,
      orderAction: order.action,
      vendor: order.vendor,
    };
  },
  {
    name: "purchaseNotifyRequester",
    description: "Notify the requester after the procurement branch finishes.",
  },
);

export const customerLookup = atom(
  (get) => {
    const escalation = get.maybe(customerEscalation);
    if (!escalation) return get.skip("No customer escalation was submitted");

    const token = get(crmAccessToken);
    return {
      workflow: "customer",
      account: escalation.account,
      tier: escalation.tier,
      issue: escalation.issue,
      sentiment: escalation.sentiment,
      owner: escalation.tier === "strategic" ? "VP Success" : "CSM",
      tokenPreview: `${token.slice(0, 4)}...`,
    };
  },
  {
    name: "customerLookup",
    description: "Load CRM context for the escalated account.",
  },
);

export const customerResponsePlan = atom(
  (get) => {
    const context = get(customerLookup);
    const needsReview =
      context.tier !== "standard" || context.sentiment !== "calm";

    if (!needsReview) {
      return {
        workflow: "customer",
        action: "send-standard-response",
        account: context.account,
        owner: context.owner,
      };
    }

    const review = get(customerResolutionReview);
    if (!review.approved) {
      return get.skip(review.note ?? "Response plan was not approved");
    }

    return {
      workflow: "customer",
      action: "send-reviewed-response",
      account: context.account,
      owner: context.owner,
      creditUsd: review.creditUsd,
      note: review.note ?? "Approved retention credit",
    };
  },
  {
    name: "customerResponsePlan",
    description:
      "Draft a response and wait for review when escalation risk is high.",
  },
);

export const customerFollowUp = atom(
  (get) => {
    const context = get(customerLookup);
    const plan = get(customerResponsePlan);
    return {
      workflow: "customer",
      action: "schedule-follow-up",
      account: context.account,
      owner: context.owner,
      responseAction: plan.action,
    };
  },
  {
    name: "customerFollowUp",
    description: "Schedule follow-up work after the customer branch completes.",
  },
);

export const branchSummary = atom(
  (get) => {
    const incident = get.maybe(incidentWrapUp);
    const purchase = get.maybe(purchaseNotifyRequester);
    const customer = get.maybe(customerFollowUp);

    const completed = [incident, purchase, customer].filter(Boolean);
    if (completed.length === 0) {
      return get.skip("No branch completed yet");
    }

    return {
      completedBranches: completed.map((result) => result?.workflow),
      result: completed[0],
    };
  },
  {
    name: "branchSummary",
    description:
      "Summarize whichever entrypoint branch was triggered for this run.",
  },
);
