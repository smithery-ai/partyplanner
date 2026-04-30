// Reference example for consuming a third-party hylo plugin.
//
// Demonstrates installing `@smithery/hylo-managed-agent` from its
// GitHub Release tarball (see this directory's package.json) and
// composing a one-shot agent dispatch workflow against the bundled
// `cloudClaudeProvider`.
//
// The plugin lives at https://github.com/smithery-ai/hylo-plugins —
// not in this monorepo. This example is the canonical proof that a
// plugin authored entirely outside hylo can be consumed by a hylo
// workflow with no special integration: peer-deps resolve through the
// workflow's own dependency tree, and the plugin's `atom()` /
// `action()` calls register against hylo's globalRegistry exactly as
// in-tree integrations do.

import {
  cloudClaudeProvider,
  managedAgent,
  resources as r,
} from "@smithery/hylo-managed-agent";
import { input, secret } from "@workflow/core";
import { z } from "zod";

// ── Trigger ──────────────────────────────────────────────────────────

export const ticket = input(
  "ticket",
  z.object({
    summary: z.string().min(1),
    repo: z
      .string()
      .regex(/^[^/]+\/[^/]+$/)
      .default("smithery-ai/sandbox"),
  }),
  {
    title: "Run the example managed-agent",
    description:
      "Dispatch a cloud-claude session to look at the named repo and post a one-line digest back via the workflow webhook.",
  },
);

// ── Result envelope ──────────────────────────────────────────────────
//
// Whatever shape your agent's webhook posts back. Must extend the
// `ManagedAgentResultEnvelope` discriminator (`status: "completed" | "failed"`).

export const ticketResult = input.deferred(
  "ticketResult",
  z.object({
    runId: z.string(),
    status: z.enum(["completed", "failed"]),
    digest: z.string().nullish(),
    error: z.string().nullish(),
  }),
);

// ── Secrets ──────────────────────────────────────────────────────────

const githubPat = secret("AGENT_GITHUB_PAT", undefined, {
  description: "GitHub PAT, exposed to the agent as SMITHERY_GH_PAT.",
});

// ── Compose the agent ────────────────────────────────────────────────

export const investigate = managedAgent({
  name: "investigate",
  provider: cloudClaudeProvider({
    workspace: "daytona-sandbox",
    model: "claude-opus-4-7",
  }),
  resources: [r.secret({ source: githubPat, env: "SMITHERY_GH_PAT" })],
  prompt: (get, ctx) => {
    const t = get(ticket);
    return `
You are a one-shot investigation agent. Look at the public README of
${t.repo} and produce a one-sentence digest summarizing what the project does.

When done, POST the envelope to ${ctx.webhookUrl}:

  curl -sS -X POST '${ctx.webhookUrl}' -H 'content-type: application/json' \\
    --data-binary @/tmp/result.json

where /tmp/result.json is:

  {
    "runId": "${ctx.runId}",
    "payload": {
      "runId": "${ctx.runId}",
      "status": "completed",
      "digest": "<one sentence>"
    }
  }

Authenticate gh CLI first: \`echo "$SMITHERY_GH_PAT" | gh auth login --with-token\`.
`;
  },
  result: ticketResult,
});

// `investigate.dispatch` is the action handle.
// `investigate.report` is the atom downstream code consumes — it kicks
// the dispatch and resolves to the agent's result envelope.

export { investigate as default };
