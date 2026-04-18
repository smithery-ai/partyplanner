import { input, atom } from "@rxwf/core"
import { z } from "zod"

// ── Inputs ────────────────────────────────────────────────────

export const incident = input(
  "incident",
  z.object({
    title: z.string().default("API latency spike").describe("Short incident title."),
    severity: z.enum(["sev1", "sev2", "sev3"]).default("sev2").describe("Severity level."),
    service: z.string().default("api-gateway").describe("Affected service name."),
    reporter: z.string().default("oncall@acme.dev").describe("Who reported the incident."),
  }),
  { description: "Initial incident report details." },
)

export const rootCauseAnalysis = input.deferred(
  "rootCauseAnalysis",
  z.object({
    cause: z.string().describe("Description of the root cause."),
    fixApplied: z.boolean().describe("Whether a fix has been applied."),
  }),
  { description: "Engineering team submits root cause after investigation." },
)

export const postmortemApproval = input.deferred(
  "postmortemApproval",
  z.object({
    approved: z.boolean().describe("Whether the postmortem document is accepted."),
    actionItems: z.array(z.string()).optional().describe("Follow-up action items."),
  }),
  { description: "Manager approves the postmortem before closing." },
)

// ── Triage ───────────────────────────────────────────────────

export const triage = atom((get) => {
  const inc = get(incident)
  const priority = inc.severity === "sev1" ? "page-all" : inc.severity === "sev2" ? "page-oncall" : "queue"
  return { action: "triage", title: inc.title, priority }
}, { name: "triage" })

// ── Notify Stakeholders ─────────────────────────────────────

export const notifyStakeholders = atom((get) => {
  const inc = get(incident)
  get(triage)
  return { action: "notify", channels: ["slack", "pagerduty"], service: inc.service }
}, { name: "notifyStakeholders" })

// ── Create Status Page ──────────────────────────────────────

export const statusPage = atom((get) => {
  const inc = get(incident)
  get(triage)
  return { action: "create-status-page", title: inc.title, status: "investigating" }
}, { name: "statusPage" })

// ── Investigate ──────────────────────────────────────────────

export const investigate = atom((get) => {
  get(notifyStakeholders)
  const rca = get(rootCauseAnalysis)
  if (!rca.fixApplied) return get.skip()
  return { action: "fix-verified", cause: rca.cause }
}, { name: "investigate" })

// ── Update Status ────────────────────────────────────────────

export const resolveStatus = atom((get) => {
  get(investigate)
  return { action: "update-status-page", status: "resolved" }
}, { name: "resolveStatus" })

// ── Write Postmortem ─────────────────────────────────────────

export const writePostmortem = atom((get) => {
  const inc = get(incident)
  const rca = get(investigate)
  return { action: "draft-postmortem", title: inc.title, cause: rca.cause }
}, { name: "writePostmortem" })

// ── Approve & Close ──────────────────────────────────────────

export const closeIncident = atom((get) => {
  get(writePostmortem)
  get(resolveStatus)
  const approval = get(postmortemApproval)
  if (!approval.approved) return get.skip()
  return { action: "close-incident", actionItems: approval.actionItems ?? [] }
}, { name: "closeIncident" })
