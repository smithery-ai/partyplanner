import { input, atom } from "@rxwf/core"
import { z } from "zod"

// ── Inputs ────────────────────────────────────────────────────

export const newUser = input(
  "newUser",
  z.object({
    email: z.string().default("jane@example.com").describe("New user's email address."),
    name: z.string().default("Jane Doe").describe("Full name."),
    plan: z.enum(["free", "pro", "enterprise"]).default("free").describe("Subscription plan."),
    referralCode: z.string().optional().describe("Optional referral or invite code."),
  }),
  { description: "Details of the user signing up." },
)

export const emailVerification = input.deferred(
  "emailVerification",
  z.object({
    verified: z.boolean().describe("Whether the user clicked the verification link."),
  }),
  { description: "User must verify their email before provisioning." },
)

export const teamInviteResponse = input.deferred(
  "teamInviteResponse",
  z.object({
    accepted: z.boolean().describe("Whether the user accepted the team invite."),
    teamId: z.string().optional().describe("Team they're joining if accepted."),
  }),
  { description: "If the user was invited to a team, they must accept or decline." },
)

// ── Create Account ───────────────────────────────────────────

export const createAccount = atom((get) => {
  const user = get(newUser)
  return { action: "create-account", email: user.email, name: user.name, plan: user.plan }
}, { name: "createAccount" })

// ── Send Verification Email ──────────────────────────────────

export const sendVerification = atom((get) => {
  const account = get(createAccount)
  return { action: "send-verification-email", email: account.email }
}, { name: "sendVerification" })

// ── Wait for Verification ────────────────────────────────────

export const verifyEmail = atom((get) => {
  get(sendVerification)
  const verification = get(emailVerification)
  if (!verification.verified) return get.skip()
  return { action: "email-verified" }
}, { name: "verifyEmail" })

// ── Check Referral ───────────────────────────────────────────

export const checkReferral = atom((get) => {
  const user = get(newUser)
  if (!user.referralCode) return get.skip()
  return { action: "validate-referral", code: user.referralCode, valid: true }
}, { name: "checkReferral" })

// ── Provision Resources ──────────────────────────────────────

export const provision = atom((get) => {
  get(verifyEmail)
  const user = get(newUser)
  return { action: "provision", plan: user.plan, database: true, storage: true }
}, { name: "provision" })

// ── Team Invite Flow ─────────────────────────────────────────

export const handleTeamInvite = atom((get) => {
  get(provision)
  const user = get(newUser)
  if (!user.referralCode) return get.skip()
  const invite = get(teamInviteResponse)
  if (!invite.accepted) return get.skip()
  return { action: "join-team", teamId: invite.teamId }
}, { name: "handleTeamInvite" })

// ── Send Welcome ─────────────────────────────────────────────

export const sendWelcome = atom((get) => {
  get(provision)
  const account = get(createAccount)
  return { action: "send-welcome-email", email: account.email }
}, { name: "sendWelcome" })
