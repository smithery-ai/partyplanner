// Type definitions mirroring `cloud-claude`'s OpenAPI schema. Kept lean —
// only the fields the integration uses on the wire are exported. Source:
// https://cloud-claude.smithery.workers.dev/openapi.json

/**
 * Which agent runtime drives the session.
 *
 * - `think` runs Cloudflare's Think on a Worker isolate — no bash, fast,
 *   cheap.
 * - `claude-code` runs Anthropic's Claude Agent SDK inside a per-session
 *   container — full POSIX, slower, costlier.
 *
 * Sticky for the lifetime of the session.
 */
export type AgentName = "claude-code" | "think";

/**
 * Filesystem layout for the session's workspace.
 *
 * - `do-sqlite`: DO SQLite only (cheapest, think-only).
 * - `do-sqlite-r2`: SQLite + R2 spillover for files >1.5 MB (think-only).
 * - `r2-path`: every file at R2 key `<sessionId>/<filePath>`. Default;
 *   compatible with both think and claude-code.
 * - `daytona-sandbox`: provisions a Daytona sandbox with an S3-backed
 *   volume mounted at /workspace; available for claude-code today.
 *   Avoids the CF Containers reaper / abort-leak issues.
 */
export type WorkspaceLayout =
  | "do-sqlite"
  | "do-sqlite-r2"
  | "r2-path"
  | "daytona-sandbox";

/**
 * Session lifecycle states.
 *
 * - `created`: session initialized; no turn executed.
 * - `running`: turn in progress.
 * - `done`: model completed normally.
 * - `input_required`: model stopped without a tool call AND ended with a
 *   question.
 * - `failed`: turn error (details in `error`).
 * - `idle`: between turns; no active work.
 */
export type SessionStatus =
  | "created"
  | "running"
  | "input_required"
  | "done"
  | "failed"
  | "idle";

export interface CreateSessionBody {
  agent?: AgentName;
  workspace?: WorkspaceLayout;
  model?: string;
  message?: string;
  githubInstallationId?: string | number;
}

export interface SessionState {
  sessionId: string;
  agent: AgentName;
  workspace: WorkspaceLayout;
  status: SessionStatus;
  model?: string;
  lastMessage?: string;
  lastTurnAt?: string;
  turnCount: number;
  error?: string;
  githubInstallationId?: string;
}

export interface EnvVars {
  vars: Record<string, string>;
}

/**
 * The default cloud-claude endpoint. Override per-call when pointing at
 * a private deployment.
 */
export const DEFAULT_CLOUD_CLAUDE_BASE_URL =
  "https://cloud-claude.smithery.workers.dev";
