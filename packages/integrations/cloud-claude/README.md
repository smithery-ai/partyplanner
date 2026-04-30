# @workflow/integrations-cloud-claude

First-class hylo integration for [`cloud-claude`](https://cloud-claude.smithery.workers.dev) — Smithery's hosted Claude Agent SDK runtime.

Replaces the ~80 lines of hand-rolled fetch boilerplate every cloud-claude consumer currently carries (create session, set env, fire-and-forget abort timing, manually pulling on the dispatch action from a downstream atom to avoid the pull-only-action footgun) with two primitives:

```ts
import { cloudClaudeSession, cloudClaudeReport } from "@workflow/integrations-cloud-claude";
import { input } from "@workflow/core";

// 1. Define the deferred input the agent's webhook resolves.
const implementResult = input.deferred("implementResult", z.object({
  runId: z.string(),
  status: z.enum(["completed", "failed"]),
  prUrl: z.string().nullish(),
  // ...workflow-specific fields
  error: z.string().nullish(),
}));

// 2. Wire the dispatch action.
const implementCommit = cloudClaudeSession({
  name: "implementCommit",
  workspace: "daytona-sandbox",
  model: "claude-opus-4-7",
  env: (get) => ({
    SMITHERY_GH_PAT: get(githubPat),
    LINEAR_API_KEY: get.maybe(linearApiKey),  // undefined drops the key
  }),
  prompt: (get, ctx) => buildPrompt({
    ticket: get(linearTicket),
    webhookUrl: ctx.webhookUrl,
    runId: ctx.runId,
  }),
});

// 3. Consume the result via the report atom — kicks the dispatch and
//    reads the deferred input in one place.
export const report = cloudClaudeReport({
  name: "implementReport",
  dispatch: implementCommit,
  result: implementResult,
});

// Downstream atoms read `report` like any other atom.
```

## What the package handles for you

- **The three-call dispatch dance** (`POST /sessions`, `PUT /env`, `POST /messages`).
- **Fire-and-forget abort timing** — defaults to a 500 ms `AbortSignal.timeout` which is empirically the sweet spot for hylo's queue-lease serialization tolerance. Holds longer than that and you trip `Unable to save run: conflict` collisions on parallel state writes.
- **The pull-only-action footgun** — hylo actions never execute unless something downstream reads them via `get(...)`. `cloudClaudeReport` does the kick for you. Without this, your workflow appears to advance through every other atom (everything depending on the deferred input parks in `waiting`) but the cloud-claude session is never actually created.
- **Sane defaults** — `agent: "claude-code"` + `workspace: "daytona-sandbox"` (avoids the CF Containers reaper bugs documented in `worker/sre-monitor-cc/README.md`).
- **Optional env values** — return `undefined` from `env(get)` for any key and it drops out of the env map (useful for optional secrets like Linear that you don't want to require at deploy time).

## What's still on you

- Defining the deferred input schema for the agent's webhook envelope (workflow-specific).
- Writing the prompt (workflow-specific) — the package gives you `runId` and `webhookUrl` via `ctx`.
- Telling the agent in the prompt to curl `${webhookUrl}` with the result envelope. The agent owns its own back-pressure / retry loop while it runs.

## Endpoints

Defaults to `https://cloud-claude.smithery.workers.dev`. Override per-action via the `baseUrl` option (accepts a literal or a hylo input handle, e.g. a `secret()` for private deployments).
