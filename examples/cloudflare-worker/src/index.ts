import { atom, input, secret } from "@workflow/core";
import { z } from "zod";

export * from "./notion";
export * from "./scheduleProbe";
export * from "./slack";
export * from "./sreMonitor";

export const incidentAlert = input(
  "incidentAlert",
  z.object({
    service: z.string(),
    severity: z.enum(["sev1", "sev2", "sev3"]),
    customerImpact: z.string(),
    detectedBy: z.enum(["synthetic", "support", "engineer"]),
  }),
  {
    title: "Respond to an incident",
    description:
      "Start the incident response workflow for a production service issue.",
  },
);

export const incidentCommsApproval = input.deferred(
  "incidentCommsApproval",
  z.object({
    approved: z.boolean(),
    channel: z.enum(["status-page", "email", "slack"]),
    note: z.string().optional(),
  }),
  {
    title: "Approve incident communications",
    description:
      "Human approval for the incident communication before publishing.",
  },
);

export const incidentPublisherToken = secret(
  "INCIDENT_PUBLISHER_TOKEN",
  undefined,
  {
    description: "Token used to publish external incident communications.",
    errorMessage: "INCIDENT_PUBLISHER_TOKEN is not available to this Worker.",
  },
);

export const incidentTriage = atom(
  (get) => {
    const alert = get(incidentAlert);
    return {
      workflow: "incident",
      action: "page-incident-commander",
      service: alert.service,
      severity: alert.severity,
      detectedBy: alert.detectedBy,
      impact: alert.customerImpact,
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

    const token = get(incidentPublisherToken);
    return {
      workflow: "incident",
      action: "publish-status-update",
      channel: approval.channel,
      service: triage.service,
      severity: triage.severity,
      message: approval.note ?? triage.impact,
      tokenPreview: `${token.slice(0, 4)}...`,
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
