import { atom, input, secret } from "@workflow/core";
import { z } from "zod";

export const alert = input(
  "alert",
  z.object({
    service: z.string().describe("Service that fired the alert."),
    region: z.string().default("us-east"),
    errorRate: z.number().describe("Current error percentage."),
    p95LatencyMs: z.number().describe("Current p95 latency in milliseconds."),
    customerImpact: z.boolean().default(false),
  }),
  { description: "Production alert payload." },
);

export const commanderUpdate = input.deferred(
  "commanderUpdate",
  z.object({
    mitigated: z.boolean().describe("Whether mitigation has been applied."),
    summary: z.string().describe("Incident commander summary."),
  }),
  { description: "Incident commander update before resolution." },
);

export const pagingApiKey = secret("PAGING_API_KEY", {
  description: "Pager service API key used to page responders.",
});

export const statusPageApiKey = secret("STATUS_PAGE_API_KEY", {
  description: "Status page API key used when an external update is required.",
});

export const assessImpact = atom(
  (get) => {
    const a = get(alert);
    if (a.customerImpact || a.errorRate >= 5) return "sev1";
    if (a.errorRate >= 1 || a.p95LatencyMs >= 1500) return "sev2";
    return "sev3";
  },
  { name: "assessImpact" },
);

export const pageResponders = atom(
  (get) => {
    const severity = get(assessImpact);
    const a = get(alert);
    const apiKey = get(pagingApiKey);
    return {
      channel: severity === "sev1" ? "war-room" : "on-call",
      service: a.service,
      region: a.region,
      severity,
      credential: apiKey.length > 0 ? "PAGING_API_KEY" : undefined,
    };
  },
  { name: "pageResponders" },
);

export const draftStatusPage = atom(
  (get) => {
    const severity = get(assessImpact);
    if (severity === "sev3") return get.skip("Status page is not required.");
    const a = get(alert);
    const apiKey = get(statusPageApiKey);
    return {
      title: `${a.service} degradation in ${a.region}`,
      severity,
      audience: a.customerImpact ? "external" : "internal",
      credential: apiKey.length > 0 ? "STATUS_PAGE_API_KEY" : undefined,
    };
  },
  { name: "draftStatusPage" },
);

export const resolveIncident = atom(
  (get) => {
    const update = get(commanderUpdate);
    if (!update.mitigated) return get.skip("Incident is still active.");
    return {
      publishRetrospective: true,
      summary: update.summary,
      responders: get(pageResponders),
    };
  },
  { name: "resolveIncident" },
);
