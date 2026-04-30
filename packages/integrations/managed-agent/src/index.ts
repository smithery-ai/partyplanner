// Public API of @workflow/integrations-managed-agent.
//
// One package, composable primitives. The brain (Provider) and the
// hands (Sandbox) are orthogonal axes — a workflow names a provider,
// optionally names a sandbox, declares resources, and gets back a
// paired (Action, Atom) handle. Concrete adapters live as named
// exports of this same package, not separate npm packages.
//
// Primitive selection follows Anthropic's Managed Agents framework
// (https://www.anthropic.com/engineering/managed-agents) — Session,
// Orchestration, Harness, Sandbox, Resources, Tools — narrowed to
// what hylo workflows need today.
//
// Workflow consumer pattern:
//
//   import {
//     managedAgent,
//     cloudClaudeProvider,
//     resources as r,
//   } from "@workflow/integrations-managed-agent";
//
//   const factory = managedAgent({
//     name: "implementCommit",
//     provider: cloudClaudeProvider({
//       workspace: "daytona-sandbox",
//       model: "claude-opus-4-7",
//     }),
//     resources: [
//       r.secret({ source: githubPat, env: "SMITHERY_GH_PAT" }),
//       r.secret({ source: linearApiKey, env: "LINEAR_API_KEY", optional: true }),
//     ],
//     prompt: (get, ctx) => buildPrompt({ ..., webhookUrl: ctx.webhookUrl }),
//     result: implementResultDeferred,
//   });
//
// `factory.dispatch` is the action handle (rarely read directly).
// `factory.report` is the atom downstream code consumes — it kicks the
// dispatch and resolves to the agent's result envelope.

export {
  type DispatchResult,
  type ManagedAgent,
  type ManagedAgentOptions,
  type ManagedAgentResultEnvelope,
  managedAgent,
  type PromptContext,
} from "./compose";

// ── Primitive interfaces ─────────────────────────────────────────────

export type {
  AgentProvider,
  AgentSessionHandle,
  CleanupPolicy,
  MountResult,
  PrepareContext,
  ProviderId,
  Resource,
  Sandbox,
  SandboxHandle,
  SandboxId,
  SandboxSpec,
  SecretRef,
  SendPromptOptions,
  SendPromptOutcome,
  Tool,
} from "./primitives";

// ── Provider adapters (the brain) ────────────────────────────────────

export {
  type AnthropicProviderOptions,
  anthropicProvider,
} from "./providers/anthropic";
export {
  type ClaudeAgentSdkProviderOptions,
  claudeAgentSdkProvider,
} from "./providers/claude-agent-sdk";
export {
  type CloudClaudeAgent,
  type CloudClaudeProviderOptions,
  type CloudClaudeWorkspace,
  cloudClaudeProvider,
} from "./providers/cloud-claude";

// ── Sandbox adapters (the hands) ─────────────────────────────────────

export {
  type DaytonaSandboxOptions,
  daytonaSandbox,
} from "./sandboxes/daytona";
export {
  type DockerSandboxOptions,
  dockerSandbox,
} from "./sandboxes/docker";
export {
  type LocalFsSandboxOptions,
  localFsSandbox,
} from "./sandboxes/local-fs";

// ── Resource builders (declarative {source_ref, mount_path}) ─────────

import * as resourceHelpers from "./resources/helpers";
export const resources = resourceHelpers;
