// `cloudClaudeProvider` — adapter for cloud-claude.smithery.workers.dev,
// Smithery's hosted Claude Agent SDK runtime.
//
// Cloud-claude is a BUNDLED provider — a single `POST /sessions` call
// chooses both the LLM execution plane (claude-code in a container,
// `think` on a Worker isolate) and the sandbox substrate (daytona /
// r2-path / do-sqlite via the `workspace` field). The composer reads
// the `bundledSandbox` marker and skips a separate Sandbox provision
// step when this provider is used.
//
// Wire calls (matches https://cloud-claude.smithery.workers.dev/openapi.json):
//   1. POST /sessions      → prepareSession  (creates session DO + container)
//   2. PUT  /sessions/:id/env → configureEnv   (per-session env vars)
//   3. POST /sessions/:id/messages → sendPrompt (fire-and-forget)
//
// The 500 ms `AbortSignal.timeout` on the messages POST is critical:
// hylo's queue-lease serialization tolerance breaks down past that
// window and we see `Unable to save run: conflict` collisions on
// parallel state writes. The cloud-claude container DO continues
// running the turn after our client aborts.

import type {
  AgentProvider,
  AgentSessionHandle,
  PrepareContext,
  SandboxId,
  SendPromptOptions,
  SendPromptOutcome,
} from "../primitives";

const DEFAULT_BASE_URL = "https://cloud-claude.smithery.workers.dev";

export type CloudClaudeAgent = "claude-code" | "think";

export type CloudClaudeWorkspace =
  | "do-sqlite"
  | "do-sqlite-r2"
  | "r2-path"
  | "daytona-sandbox";

export interface CloudClaudeProviderOptions {
  /**
   * Which cloud-claude agent runtime to use. Defaults to `claude-code`
   * — the substrate that exposes bash/git/gh which most workflows want.
   */
  agent?: CloudClaudeAgent;
  /**
   * Workspace substrate. Defaults to `daytona-sandbox` for `claude-code`
   * (avoids the CF Containers reaper / abort-leak issues we hit during
   * prototyping); falls back to `r2-path` otherwise.
   */
  workspace?: CloudClaudeWorkspace;
  /** Cloud-claude model id; provider's runtime default applies if omitted. */
  model?: string;
  /** Override the cloud-claude endpoint. Defaults to the public Workers URL. */
  baseUrl?: string;
  /** Optional GitHub App installation id pinned to the session. */
  githubInstallationId?: string | number;
}

export function cloudClaudeProvider<TEnvelope = unknown>(
  opts: CloudClaudeProviderOptions = {},
): AgentProvider<TEnvelope> {
  const agent: CloudClaudeAgent = opts.agent ?? "claude-code";
  const workspace: CloudClaudeWorkspace =
    opts.workspace ?? (agent === "claude-code" ? "daytona-sandbox" : "r2-path");
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");

  // The bundledSandbox marker tells the composer to skip a separate
  // Sandbox.provision() call. We expose the workspace verbatim — that
  // way logs / debugging make it obvious which substrate the session ran
  // against ("daytona-sandbox" vs "r2-path" vs "do-sqlite").
  const bundledSandbox: SandboxId = workspace;

  return {
    id: "cloud-claude",
    bundledSandbox,

    async prepareSession(_ctx: PrepareContext): Promise<AgentSessionHandle> {
      const body: Record<string, unknown> = { agent, workspace };
      if (opts.model) body.model = opts.model;
      if (opts.githubInstallationId !== undefined) {
        body.githubInstallationId = opts.githubInstallationId;
      }
      const res = await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new Error(
          `cloud-claude POST /sessions ${res.status}: ${(await res.text()).slice(0, 500)}`,
        );
      }
      const parsed = (await res.json()) as { sessionId?: string };
      if (!parsed.sessionId) {
        throw new Error(
          `cloud-claude POST /sessions returned no sessionId: ${JSON.stringify(parsed).slice(0, 500)}`,
        );
      }
      return {
        sessionId: parsed.sessionId,
        providerData: { baseUrl, agent, workspace, model: opts.model },
      };
    },

    async configureEnv(
      handle: AgentSessionHandle,
      vars: Record<string, string>,
    ): Promise<void> {
      if (Object.keys(vars).length === 0) return;
      const res = await fetch(
        `${baseUrl}/sessions/${encodeURIComponent(handle.sessionId)}/env`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ vars }),
        },
      );
      if (!res.ok) {
        throw new Error(
          `cloud-claude PUT /env ${res.status}: ${(await res.text()).slice(0, 500)}`,
        );
      }
    },

    async sendPrompt(
      handle: AgentSessionHandle,
      prompt: string,
      promptOpts: SendPromptOptions,
    ): Promise<SendPromptOutcome> {
      const dispatchedAt = new Date().toISOString();
      try {
        await fetch(
          `${baseUrl}/sessions/${encodeURIComponent(handle.sessionId)}/messages`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ message: prompt }),
            signal: AbortSignal.timeout(promptOpts.handoffMs),
          },
        );
        // If the turn somehow finished within the handoff window, the
        // agent already curled back to the webhook — no further action.
        return { kind: "dispatched", dispatchedAt };
      } catch (err) {
        const name = (err as { name?: string }).name;
        // AbortError (we aborted) and TimeoutError (signal fired) are
        // the expected handoff path; anything else is a real failure.
        if (name === "AbortError" || name === "TimeoutError") {
          return { kind: "dispatched", dispatchedAt };
        }
        return {
          kind: "failed",
          dispatchedAt,
          error: (err as Error).message,
        };
      }
    },

    async abort(handle: AgentSessionHandle): Promise<void> {
      // Best-effort. cloud-claude exposes /abort but its handleAbort
      // doesn't always write terminal state — known issue tracked
      // upstream.
      await fetch(
        `${baseUrl}/sessions/${encodeURIComponent(handle.sessionId)}/abort`,
        { method: "POST" },
      ).catch(() => undefined);
    },
  };
}
