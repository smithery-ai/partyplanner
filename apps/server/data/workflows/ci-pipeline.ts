import { input, atom } from "@rxwf/core"
import { z } from "zod"

// ── Inputs ────────────────────────────────────────────────────

export const repo = input(
  "repo",
  z.object({
    owner: z.string().default("acme").describe("GitHub org or user."),
    name: z.string().default("web-app").describe("Repository name."),
    branch: z.string().default("main").describe("Branch to build."),
    commitSha: z.string().default("HEAD").describe("Commit SHA to build."),
  }),
  { description: "Repository and branch to run CI against." },
)

export const manualQaApproval = input.deferred(
  "manualQaApproval",
  z.object({
    approved: z.boolean().describe("Whether QA passed manual checks."),
    notes: z.string().optional().describe("QA tester notes or bug references."),
  }),
  { description: "Manual QA gate after staging deploy." },
)

// ── Lint & Type Check ────────────────────────────────────────

export const lint = atom((get) => {
  const r = get(repo)
  return { action: "lint", repo: `${r.owner}/${r.name}`, branch: r.branch }
}, { name: "lint" })

export const typeCheck = atom((get) => {
  const r = get(repo)
  return { action: "type-check", repo: `${r.owner}/${r.name}`, branch: r.branch }
}, { name: "typeCheck" })

// ── Unit Tests ───────────────────────────────────────────────

export const unitTests = atom((get) => {
  get(lint)
  get(typeCheck)
  const r = get(repo)
  return { action: "unit-tests", repo: `${r.owner}/${r.name}`, passed: true }
}, { name: "unitTests" })

// ── Build ────────────────────────────────────────────────────

export const build = atom((get) => {
  get(unitTests)
  const r = get(repo)
  return { action: "build", artifact: `${r.name}-${(r.commitSha ?? "HEAD").slice(0, 7)}.tar.gz` }
}, { name: "build" })

// ── Deploy to Staging ────────────────────────────────────────

export const deployStaging = atom((get) => {
  const artifact = get(build)
  return { action: "deploy-staging", artifact: artifact.artifact, env: "staging" }
}, { name: "deployStaging" })

// ── Integration Tests ────────────────────────────────────────

export const integrationTests = atom((get) => {
  get(deployStaging)
  return { action: "integration-tests", env: "staging", passed: true }
}, { name: "integrationTests" })

// ── Manual QA ────────────────────────────────────────────────

export const qaGate = atom((get) => {
  get(integrationTests)
  const qa = get(manualQaApproval)
  if (!qa.approved) return get.skip()
  return { action: "qa-passed", notes: qa.notes }
}, { name: "qaGate" })

// ── Deploy to Production ─────────────────────────────────────

export const deployProd = atom((get) => {
  get(qaGate)
  const artifact = get(build)
  return { action: "deploy-prod", artifact: artifact.artifact, env: "production" }
}, { name: "deployProd" })
