// `cloudClaudeSession` — the canonical action primitive for dispatching
// a cloud-claude agent turn from a hylo workflow.
//
// What it does:
//   1. POST /sessions            (create the session)
//   2. PUT  /sessions/:id/env    (inject any env vars the agent needs)
//   3. POST /sessions/:id/messages   (fire-and-forget — abort after the
//                                     handoff window, container DO keeps
//                                     running the turn)
//
// The session result lands back in hylo via a deferred input that the
// agent inside the container resolves by curling the workflow webhook.
// This package exposes `cloudClaudeReport` to consume that paired action
// + deferred input pattern with the action-kick wired in (see report.ts);
// using both together eliminates the pull-only-action footgun where an
// action with no downstream `get(...)` reader silently never fires.

import {
  type Action,
  action,
  type Get,
  type Handle,
  isHandle,
} from "@workflow/core";
import { defaultAppBaseUrl } from "@workflow/integrations-oauth";
import {
  createSession,
  DEFAULT_DISPATCH_HANDOFF_MS,
  fireMessage,
  putEnv,
} from "./api";
import {
  type AgentName,
  DEFAULT_CLOUD_CLAUDE_BASE_URL,
  type WorkspaceLayout,
} from "./types";

type MaybeHandle<T> = Handle<T> | T;

/**
 * Resolved when the action's body runs — surfaces what's needed to
 * build the prompt without making the caller plumb it themselves.
 */
export interface CloudClaudePromptContext {
  /** The hylo run id of the run that dispatched this turn. */
  runId: string;
  /**
   * The webhook URL the agent should POST its result envelope to. Wires
   * the session back to the workflow's deferred input.
   */
  webhookUrl: string;
}

/**
 * Outcome of a successful dispatch. Echoed into run state under the
 * action's name; downstream atoms can read this for tracing
 * (sessionId is the hook into cloud-claude logs / debug).
 */
export interface CloudClaudeDispatchResult {
  sessionId: string;
  dispatchedAt: string;
  baseUrl: string;
  status: "dispatched";
}

export interface CloudClaudeSessionOptions {
  /**
   * Identifier for the action node in the workflow graph. Shows up in
   * run docs, logs, and the hylo client UI.
   */
  name: string;
  /**
   * Override the cloud-claude endpoint. Accepts a literal or a hylo
   * input handle (e.g. a `secret()`). Defaults to the public Workers URL.
   */
  baseUrl?: MaybeHandle<string>;
  /**
   * Which cloud-claude agent runtime to use. Defaults to `claude-code`
   * since the substrate that exposes bash/git/gh is what most hylo
   * workflows want.
   */
  agent?: AgentName;
  /**
   * Workspace layout. Defaults to `daytona-sandbox` for `claude-code`
   * (avoids the CF Containers reaper bugs documented elsewhere); falls
   * back to `r2-path` otherwise.
   */
  workspace?: WorkspaceLayout;
  /** Cloud-claude model id. Optional — the runtime's default applies if omitted. */
  model?: string;
  /**
   * Env vars to inject into the per-session container at turn start.
   * Build them from `get(...)` calls so secrets flow through hylo's
   * dependency graph instead of being captured at construction time.
   *
   * Returning an `undefined` value for any key drops it from the env;
   * useful for optional secrets you don't want to require.
   */
  env?: (get: Get) => Record<string, string | undefined>;
  /**
   * Build the agent's prompt. `ctx` carries the run id and the webhook
   * URL the agent should curl its result back to.
   */
  prompt: (get: Get, ctx: CloudClaudePromptContext) => string | Promise<string>;
  /**
   * How long to wait before aborting the messages POST. Default is 500
   * ms which keeps the action under hylo's queue lease serialization
   * tolerance. Bump if you have evidence cloud-claude is dropping
   * requests within the window.
   */
  handoffMs?: number;
  /**
   * Optional GitHub App installation id. Pinned to the session and
   * reused on every turn so the agent gets a freshly minted GH token.
   */
  githubInstallationId?: MaybeHandle<string | number | undefined>;
}

/**
 * Register a `cloud-claude` dispatch action on the workflow graph. The
 * returned handle can be `get(...)`'d from downstream atoms to:
 *   - kick the dispatch (actions are pull-only in hylo)
 *   - read the session id for tracing / debug links
 */
export function cloudClaudeSession(
  opts: CloudClaudeSessionOptions,
): Action<CloudClaudeDispatchResult> {
  const handoffMs = opts.handoffMs ?? DEFAULT_DISPATCH_HANDOFF_MS;
  const agent: AgentName = opts.agent ?? "claude-code";
  const workspace: WorkspaceLayout =
    opts.workspace ?? (agent === "claude-code" ? "daytona-sandbox" : "r2-path");

  return action(
    async (get, _requestIntervention, ctx) => {
      const baseUrl =
        resolve(get, opts.baseUrl) ?? DEFAULT_CLOUD_CLAUDE_BASE_URL;
      const appBase = get(defaultAppBaseUrl).replace(/\/+$/, "");
      const webhookUrl = `${appBase}/api/workflow/webhooks`;

      const prompt = await opts.prompt(get, {
        runId: ctx.runId,
        webhookUrl,
      });

      const githubInstallationId = resolveOptional(
        get,
        opts.githubInstallationId,
      );

      const { sessionId } = await createSession(baseUrl, {
        agent,
        workspace,
        ...(opts.model ? { model: opts.model } : {}),
        ...(githubInstallationId !== undefined ? { githubInstallationId } : {}),
      });

      if (opts.env) {
        const raw = opts.env(get);
        const vars: Record<string, string> = {};
        for (const [k, v] of Object.entries(raw)) {
          if (typeof v === "string" && v.length > 0) vars[k] = v;
        }
        if (Object.keys(vars).length > 0) {
          await putEnv(baseUrl, sessionId, { vars });
        }
      }

      const dispatchedAt = new Date().toISOString();
      await fireMessage(baseUrl, sessionId, prompt, handoffMs);

      return {
        sessionId,
        dispatchedAt,
        baseUrl,
        status: "dispatched" as const,
      };
    },
    { name: opts.name },
  );
}

function resolve<T>(
  get: Get,
  value: MaybeHandle<T> | undefined,
): T | undefined {
  if (value === undefined) return undefined;
  return isHandle(value) ? get(value) : value;
}

function resolveOptional<T>(
  get: Get,
  value: MaybeHandle<T | undefined> | undefined,
): T | undefined {
  if (value === undefined) return undefined;
  return isHandle(value) ? get(value) : value;
}
