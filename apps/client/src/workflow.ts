import { input, atom } from "@rxwf/core"
import { z } from "zod"

// ── Inputs ────────────────────────────────────────────────────

export const provider = input("provider", z.object({
  name: z.string().default("Acme MCP"),
  openapiUrl: z.string().optional(),
  mcpUrl: z.string().default("https://mcp.acme.dev"),
  hasDcr: z.boolean().default(true),
}))

export const oauthCreds = input.deferred("oauthCreds", z.object({
  clientId: z.string(),
  clientSecret: z.string(),
}))

export const overlayReview = input.deferred("overlayReview", z.object({
  approved: z.boolean(),
  strippedPaths: z.array(z.string()).optional(),
}))

export const prodApproval = input.deferred("prodApproval", z.object({
  approved: z.boolean(),
  confirmCode: z.string(),
}))

// ── Discovery & Assessment ───────────────────────────────────

export const assess = atom((get) => {
  const p = get(provider)
  if (p.mcpUrl && p.hasDcr) return "dcr-proxy"
  if (p.mcpUrl && !p.hasDcr) return "oauth-proxy"
  if (p.openapiUrl) return "dispatch-worker"
  return "blocked"
}, { name: "assess" })

// ── Path 1: DCR Proxy ────────────────────────────────────────

export const dcrProxy = atom((get) => {
  const path = get(assess)
  if (path !== "dcr-proxy") return get.skip()
  const p = get(provider)
  return { action: "publish-dcr", mcpUrl: p.mcpUrl, provider: p.name }
}, { name: "dcrProxy" })

// ── Path 2: OAuth Proxy ──────────────────────────────────────

export const oauthProxy = atom((get) => {
  const path = get(assess)
  if (path !== "oauth-proxy") return get.skip()
  const p = get(provider)
  const creds = get(oauthCreds)
  return { action: "deploy-oauth-proxy", mcpUrl: p.mcpUrl, provider: p.name, creds }
}, { name: "oauthProxy" })

// ── Path 3: Dispatch Worker ──────────────────────────────────

export const buildSpec = atom((get) => {
  const path = get(assess)
  if (path !== "dispatch-worker") return get.skip()
  const p = get(provider)
  return { action: "build-spec", openapiUrl: p.openapiUrl, provider: p.name }
}, { name: "buildSpec" })

export const applyOverlay = atom((get) => {
  const spec = get(buildSpec)
  const review = get(overlayReview)
  if (!review.approved) return get.skip()
  return { action: "apply-overlay", provider: spec.provider, strippedPaths: review.strippedPaths }
}, { name: "applyOverlay" })

export const deployTest = atom((get) => {
  const overlay = get(applyOverlay)
  return { action: "deploy-test", provider: overlay.provider, namespace: "test" }
}, { name: "deployTest" })

export const scanTools = atom((get) => {
  const deployed = get(deployTest)
  return { action: "scan-tools", provider: deployed.provider }
}, { name: "scanTools" })

// ── Converge: Deploy to Prod ─────────────────────────────────

export const deployProd = atom((get) => {
  const path = get(assess)
  const target =
    path === "dcr-proxy" ? get(dcrProxy) :
    path === "oauth-proxy" ? get(oauthProxy) :
    path === "dispatch-worker" ? get(scanTools) :
    get.skip()
  const approval = get(prodApproval)
  if (!approval.approved) return get.skip()
  return { action: "deploy-prod", provider: target.provider }
}, { name: "deployProd" })
