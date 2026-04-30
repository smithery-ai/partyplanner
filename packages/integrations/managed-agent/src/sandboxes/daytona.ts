// `daytonaSandbox` — STUB. Implementation deferred.
//
// Provisions a Daytona sandbox via Daytona's API. Pair with an unbundled
// provider (`anthropicProvider`, `claudeAgentSdkProvider`) so the agent's
// tool calls can target a Daytona-managed shell environment.
//
// NOTE: when paired with `cloudClaudeProvider({ workspace: "daytona-sandbox" })`,
// you DO NOT also wire this `daytonaSandbox` — cloud-claude provisions
// the sandbox internally. The composer enforces this via the
// `bundledSandbox` marker on the provider.
//
// Implementation outline:
//   - provision: call Daytona API to create a sandbox; return the
//     sandbox id + workspace URL
//   - mount: for `git` resources, run `git clone` inside the sandbox;
//     for `secret`/`env` resources, set sandbox env vars; for `file`,
//     upload via Daytona's filesystem API
//   - stop / cleanup: tear down the sandbox

import type { Handle } from "@workflow/core";
import type {
  CleanupPolicy,
  MountResult,
  Resource,
  Sandbox,
  SandboxHandle,
  SandboxSpec,
} from "../primitives";

export interface DaytonaSandboxOptions {
  /**
   * Daytona API key. Carries a hylo handle so the value flows through
   * the dependency graph and gets resolved per-run.
   */
  apiKey: Handle<string>;
  /** Optional region / cluster id. */
  region?: string;
  /** Default container image when the spec doesn't override. */
  defaultImage?: string;
}

export function daytonaSandbox(_opts: DaytonaSandboxOptions): Sandbox {
  return {
    id: "daytona",

    async provision(_spec: SandboxSpec): Promise<SandboxHandle> {
      throw new Error(
        "daytonaSandbox: not implemented yet. See sandboxes/daytona.ts for the implementation outline.",
      );
    },
    async mount(
      _handle: SandboxHandle,
      _resource: Resource,
    ): Promise<MountResult> {
      throw new Error("daytonaSandbox: not implemented yet.");
    },
    async stop(_handle: SandboxHandle, _reason: string): Promise<void> {
      throw new Error("daytonaSandbox: not implemented yet.");
    },
    async cleanup(
      _handle: SandboxHandle,
      _policy: CleanupPolicy,
    ): Promise<void> {
      throw new Error("daytonaSandbox: not implemented yet.");
    },
  };
}
