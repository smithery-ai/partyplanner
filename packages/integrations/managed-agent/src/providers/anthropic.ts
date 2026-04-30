// `anthropicProvider` — STUB. Implementation deferred.
//
// Calls Anthropic's `messages.create` directly. The tool-call loop
// runs in our process (or the workflow worker) rather than inside a
// provider-managed container.
//
// Unlike `cloudClaudeProvider`, this provider is NOT bundled — the
// composer will require a separate `Sandbox` arg (e.g. `daytonaSandbox`,
// `localFsSandbox`) to give the loop a place for tool calls to execute.
//
// Implementation outline (when this gets built):
//   - prepareSession: allocate an in-process loop state (no remote call)
//   - configureEnv:   forward to the Sandbox the composer also wires up
//   - sendPrompt:     run the tool-call loop:
//       loop:
//         resp = anthropic.messages.create({ model, tools, messages })
//         if resp.stop_reason === "end_turn": post envelope to webhookUrl, break
//         if resp.stop_reason === "tool_use":
//           dispatch each tool_use block to Sandbox.execute (or HTTP fetch
//           for non-shell tools), append tool_result
//   - abort: flip a flag the loop reads between turns

import type {
  AgentProvider,
  AgentSessionHandle,
  PrepareContext,
  SendPromptOptions,
  SendPromptOutcome,
} from "../primitives";

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  /** Optional override for the Anthropic API base URL. */
  baseUrl?: string;
  /**
   * Tool definitions exposed to the model. RFC §6.1.6 descriptor shape
   * (name/description/inputSchema only).
   */
  tools?: Array<{ name: string; description: string; inputSchema: unknown }>;
}

export function anthropicProvider<TEnvelope = unknown>(
  _opts: AnthropicProviderOptions,
): AgentProvider<TEnvelope> {
  return {
    id: "anthropic",
    // Unbundled — composer must supply a Sandbox arg.
    bundledSandbox: undefined,

    async prepareSession(_ctx: PrepareContext): Promise<AgentSessionHandle> {
      throw new Error(
        "anthropicProvider: not implemented yet. See providers/anthropic.ts for the implementation outline.",
      );
    },
    async configureEnv(): Promise<void> {
      throw new Error("anthropicProvider: not implemented yet.");
    },
    async sendPrompt(
      _handle: AgentSessionHandle,
      _prompt: string,
      _opts: SendPromptOptions,
    ): Promise<SendPromptOutcome> {
      throw new Error("anthropicProvider: not implemented yet.");
    },
  };
}
