// `cloudClaudeReport` — the canonical atom primitive for consuming a
// cloud-claude session result.
//
// It does two things every cloud-claude consumer needs:
//
//   1. Pulls on the dispatch action so the session actually fires.
//      Hylo actions are pull-only — an action with no downstream
//      `get(...)` reader silently never executes. Without this kick
//      the workflow advances through every other atom (everything that
//      depends on the deferred input parks in `waiting`) but the
//      cloud-claude session is never created.
//
//   2. Reads the deferred input the agent's webhook resolves, and
//      either returns the resolved envelope or skips with the agent's
//      error message.
//
// Pair this with `cloudClaudeSession()` and a `input.deferred()` and
// you've removed the two most common cloud-claude integration footguns
// from the caller's surface.

import {
  type Action,
  type Atom,
  atom,
  type DeferredInput,
} from "@workflow/core";
import type { CloudClaudeDispatchResult } from "./session";

/**
 * Shape every cloud-claude result envelope must satisfy. The agent's
 * webhook payload includes a `status` discriminator and an optional
 * `error` string — the rest is workflow-specific.
 */
export interface CloudClaudeResultEnvelope {
  status: "completed" | "failed";
  error?: string | null;
}

export interface CloudClaudeReportOptions<T extends CloudClaudeResultEnvelope> {
  /** Identifier for the atom node in the workflow graph. */
  name: string;
  /** The dispatch action handle returned by `cloudClaudeSession()`. */
  dispatch: Action<CloudClaudeDispatchResult>;
  /**
   * The deferred input the agent's webhook resolves. Must include the
   * `status` discriminator and (optionally) `error` from
   * `CloudClaudeResultEnvelope`; carries any additional workflow
   * payload as part of the same shape.
   */
  result: DeferredInput<T>;
  /** Human-readable description for logs / UI. */
  description?: string;
}

/**
 * Produce an atom whose value is the resolved deferred-input envelope.
 *
 * - On `result.status === "failed"`, the atom skips with the agent's
 *   error string (or a generic fallback if absent). Downstream atoms
 *   that depend on this one will be skipped too.
 * - On `result.status === "completed"`, returns the envelope as-is.
 */
export function cloudClaudeReport<T extends CloudClaudeResultEnvelope>(
  opts: CloudClaudeReportOptions<T>,
): Atom<T> {
  return atom(
    (get) => {
      // (1) Kick the dispatch action. Without this, hylo never fires
      //     the cloud-claude session because actions are pull-only.
      get(opts.dispatch);
      // (2) Read the deferred input. The webhook resolves it.
      const envelope = get(opts.result);
      if (envelope.status === "failed") {
        return get.skip(envelope.error ?? "cloud-claude investigation failed");
      }
      return envelope;
    },
    {
      name: opts.name,
      description:
        opts.description ??
        "The cloud-claude agent's result envelope, surfaced via the deferred-input webhook.",
    },
  );
}
