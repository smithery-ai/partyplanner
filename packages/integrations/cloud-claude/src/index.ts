// Public API of @workflow/integrations-cloud-claude.
//
// First-class hylo integration for `cloud-claude` — Smithery's hosted
// Claude Agent SDK runtime (https://cloud-claude.smithery.workers.dev).
//
// Two primitives cover every dispatch-and-collect pattern we've seen in
// real workflows:
//
//   cloudClaudeSession({ name, agent, workspace, env, prompt, ... })
//     → registers an action that creates a session, sets env, and fires
//       a fire-and-forget messages POST. Container DO keeps running
//       the turn after our client aborts.
//
//   cloudClaudeReport({ name, dispatch, result })
//     → registers an atom that kicks the dispatch (fixing the pull-only-
//       action footgun) AND reads the deferred input the agent's webhook
//       resolves, returning the result envelope or skipping on failure.
//
// Together they reduce a typical cloud-claude consumer to ~30 lines of
// hylo workflow code instead of the ~80-line hand-rolled boilerplate
// each new workflow currently carries.

// Lower-level HTTP wrappers, exposed for callers who want to do
// something the high-level primitives don't cover (e.g. a one-off
// transcript fetch, or testing). Most workflows shouldn't need these.
export {
  createSession,
  DEFAULT_DISPATCH_HANDOFF_MS,
  fireMessage,
  putEnv,
} from "./api";

export {
  type CloudClaudeReportOptions,
  type CloudClaudeResultEnvelope,
  cloudClaudeReport,
} from "./report";
export {
  type CloudClaudeDispatchResult,
  type CloudClaudePromptContext,
  type CloudClaudeSessionOptions,
  cloudClaudeSession,
} from "./session";
export {
  type AgentName,
  DEFAULT_CLOUD_CLAUDE_BASE_URL,
  type SessionState,
  type SessionStatus,
  type WorkspaceLayout,
} from "./types";
