// HTTP wrappers for the three cloud-claude endpoints the dispatch flow
// touches: create session, set env, fire-and-forget messages.
//
// Kept tiny on purpose — these are the wire calls, nothing more. The
// orchestration logic (when to call each, what to await, how to handle
// the abort) lives in `session.ts`.

import type { CreateSessionBody, EnvVars, SessionState } from "./types";

/**
 * Strip a trailing slash so we can `${base}/sessions` without doubling
 * up. Tolerates both forms on input.
 */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * `POST /sessions` — create a new cloud-claude session. Returns the
 * session id; subsequent calls (env, messages) target that id.
 */
export async function createSession(
  baseUrl: string,
  body: CreateSessionBody,
): Promise<{ sessionId: string }> {
  const res = await fetch(`${normalizeBaseUrl(baseUrl)}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      `cloud-claude POST /sessions ${res.status}: ${(await res.text()).slice(0, 500)}`,
    );
  }
  const parsed = (await res.json()) as Partial<SessionState>;
  if (!parsed.sessionId) {
    throw new Error(
      `cloud-claude POST /sessions returned no sessionId: ${JSON.stringify(parsed).slice(0, 500)}`,
    );
  }
  return { sessionId: parsed.sessionId };
}

/**
 * `PUT /sessions/:id/env` — set per-session env vars that get injected
 * into the container at turn start. Soft-secret: the agent's bash can
 * `echo` them, so pair with a skill prompt that says not to.
 *
 * Reserved env names (HOME, PATH, GITHUB_TOKEN, SMITHERY_API_KEY, etc.)
 * are rejected by cloud-claude with HTTP 400.
 */
export async function putEnv(
  baseUrl: string,
  sessionId: string,
  body: EnvVars,
): Promise<void> {
  const res = await fetch(
    `${normalizeBaseUrl(baseUrl)}/sessions/${encodeURIComponent(sessionId)}/env`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    throw new Error(
      `cloud-claude PUT /env ${res.status}: ${(await res.text()).slice(0, 500)}`,
    );
  }
}

/**
 * `POST /sessions/:id/messages` — fire-and-forget. Once cloud-claude
 * receives the body and routes it to the session DO, the DO owns the
 * turn; our client can disconnect.
 *
 * Why fire-and-forget: the messages POST blocks for the full agent turn
 * (1–5 min for non-trivial work). Hylo's queue lease is 30s — a step
 * that holds an `await fetch` longer than that gets re-claimed and
 * parallel state writes collide with `Unable to save run: conflict`.
 *
 * 500 ms is empirically the sweet spot for hylo's serialization
 * tolerance: long enough for cloud-claude to receive the request body
 * and write `status=running` to the session DO, short enough that hylo
 * doesn't fan out a retry. Once the abort fires, the cloud-claude
 * container DO continues running the turn independently and the agent
 * inside it is responsible for posting back via the webhook.
 */
export const DEFAULT_DISPATCH_HANDOFF_MS = 500;

export async function fireMessage(
  baseUrl: string,
  sessionId: string,
  message: string,
  handoffMs: number = DEFAULT_DISPATCH_HANDOFF_MS,
): Promise<void> {
  try {
    await fetch(
      `${normalizeBaseUrl(baseUrl)}/sessions/${encodeURIComponent(sessionId)}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message }),
        signal: AbortSignal.timeout(handoffMs),
      },
    );
    // If the turn somehow finished within the handoff window, the agent
    // already curled back to the webhook — no further action needed.
  } catch (err) {
    const name = (err as { name?: string }).name;
    // AbortError (we aborted) and TimeoutError (signal fired) are the
    // expected handoff path; anything else is a real failure.
    if (name === "AbortError" || name === "TimeoutError") return;
    throw err;
  }
}
