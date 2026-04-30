// `claudeAgentSdkProvider` — STUB. Implementation deferred.
//
// Spawns the local `claude` CLI (Anthropic's Claude Agent SDK harness)
// via a child process. Unbundled — pair with a Sandbox of your choice.
//
// Useful for local dev where developers want to run the same agent
// loop as cloud-claude without provisioning a remote container.
//
// Implementation outline (when this gets built):
//   - prepareSession: spawn the `claude` binary with the right flags;
//     wire stdio for prompt/turn protocol
//   - configureEnv:   pass through to the spawned process env
//   - sendPrompt:     write to the process's prompt channel; await
//                     turn completion through stdout protocol
//   - abort: SIGTERM the child process

import type {
  AgentProvider,
  AgentSessionHandle,
  PrepareContext,
  SendPromptOptions,
  SendPromptOutcome,
} from "../primitives";

export interface ClaudeAgentSdkProviderOptions {
  /** Path to the `claude` binary. */
  binary?: string;
  model?: string;
}

export function claudeAgentSdkProvider<TEnvelope = unknown>(
  _opts: ClaudeAgentSdkProviderOptions = {},
): AgentProvider<TEnvelope> {
  return {
    id: "claude-agent-sdk",
    bundledSandbox: undefined,

    async prepareSession(_ctx: PrepareContext): Promise<AgentSessionHandle> {
      throw new Error(
        "claudeAgentSdkProvider: not implemented yet. See providers/claude-agent-sdk.ts for the implementation outline.",
      );
    },
    async configureEnv(): Promise<void> {
      throw new Error("claudeAgentSdkProvider: not implemented yet.");
    },
    async sendPrompt(
      _handle: AgentSessionHandle,
      _prompt: string,
      _opts: SendPromptOptions,
    ): Promise<SendPromptOutcome> {
      throw new Error("claudeAgentSdkProvider: not implemented yet.");
    },
  };
}
