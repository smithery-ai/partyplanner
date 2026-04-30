# @workflow/integrations-managed-agent

Generic managed-agent primitives for hylo workflows. One package, composable adapters. Aligned with the [fireline RFC §6 "Managed-Agent Primitives"](https://github.com/gurdasnijor/fireline/blob/main/rfc/concepts/managed-agent-primitives.md) and [§18 "Provider and Resource Model"](https://github.com/gurdasnijor/fireline/blob/main/rfc/coding/providers-resources-sandboxes.md).

The brain (Provider) and the hands (Sandbox) are independent axes. A workflow names a Provider and (when the provider isn't bundled) a Sandbox, declares Resources, and gets back a paired `(Action, Atom)` handle:

```ts
import {
  managedAgent,
  cloudClaudeProvider,
  resources as r,
} from "@workflow/integrations-managed-agent";

const factory = managedAgent({
  name: "implementCommit",
  provider: cloudClaudeProvider({
    workspace: "daytona-sandbox",   // bundled sandbox — no separate `sandbox:` arg
    model: "claude-opus-4-7",
  }),
  resources: [
    r.secret({ source: githubPat,    env: "SMITHERY_GH_PAT" }),
    r.secret({ source: linearApiKey, env: "LINEAR_API_KEY", optional: true }),
  ],
  prompt: (get, ctx) => buildPrompt({ ticket: get(linearTicket), webhookUrl: ctx.webhookUrl }),
  result: implementResultDeferred,
});

// Downstream atoms read `factory.report` like any other atom.
```

Switching the brain or hands is editing one line:

```ts
// Anthropic API + Daytona, freely composed (both stubs today)
const factory = managedAgent({
  name: "implementCommit",
  provider: anthropicProvider({ apiKey: get(anthropicKey), model: "claude-opus-4-7" }),
  sandbox:  daytonaSandbox({ apiKey: get(daytonaKey), region: "us-east-1" }),
  resources: [
    r.git({ repo: "smithery-ai/mono", mount: "/workspace/repo" }),
    r.secret({ source: githubPat, env: "SMITHERY_GH_PAT" }),
  ],
  prompt: ..., result: ...,
});

// Local dev: claude CLI + tmp dir (both stubs today)
const factory = managedAgent({
  name: "implementCommit",
  provider: claudeAgentSdkProvider({ binary: "/usr/local/bin/claude" }),
  sandbox:  localFsSandbox({ workdir: "/tmp/factory" }),
  resources: [...],
});
```

## Primitives

| primitive | RFC §  | interface | what it abstracts |
|---|---|---|---|
| `AgentProvider` | §6.1.3 + §18 | `prepareSession`, `configureEnv`, `sendPrompt`, `abort?` | the LLM execution plane (the brain) |
| `Sandbox` | §6.1.4 + §18.3 | `provision`, `mount`, `stop?`, `cleanup?` | where tool calls execute (the hands) |
| `Resource` | §6.1.5 | declarative `{ source_ref, mount_path }` | git repos, files, secrets, env vars |
| `Tool` | §6.1.6 | `name` / `description` / `inputSchema` only | future — currently providers expose tools natively to the model |

## Adapters

### Providers (the brain)

| adapter | bundled? | status |
|---|---|---|
| `cloudClaudeProvider` | yes (workspace = sandbox) | implemented |
| `anthropicProvider` | no | stub — interface defined, body throws |
| `claudeAgentSdkProvider` | no | stub — interface defined, body throws |

### Sandboxes (the hands)

| adapter | runs on | status |
|---|---|---|
| `daytonaSandbox` | Daytona managed VMs | stub |
| `localFsSandbox` | local filesystem (dev) | stub |
| `dockerSandbox` | local Docker (dev) | stub |

The cloud-claude+daytona-sandbox combination today is the bundled path: cloud-claude provisions the Daytona sandbox internally via its `workspace` field. Future configurations (anthropicProvider + daytonaSandbox, etc.) will exercise the unbundled path.

## What the composer handles for you

- **Three-call dispatch dance** (provision session, set env, fire-and-forget prompt) — abstracted behind the Provider interface.
- **Fire-and-forget abort timing** — defaults to a 500 ms `AbortSignal.timeout`, empirically the sweet spot under hylo's queue-lease serialization tolerance. Holds longer than that and you trip `Unable to save run: conflict` collisions.
- **The pull-only-action footgun** — the `report` atom auto-pulls on the dispatch action. Without this, hylo never fires the action because actions are pull-only.
- **Bundled-vs-unbundled provider/sandbox composition** — the composer reads `provider.bundledSandbox` and either skips a separate sandbox provision (when bundled) or requires it (when not). Mismatches throw at `managedAgent()` construction time, not at runtime.
- **Optional secrets** — `r.secret({ ..., optional: true })` drops the resource silently when the source is unbound; required secrets throw with a clear error.

## What stays workflow-specific

- The `input.deferred()` schema for the agent's webhook envelope.
- The prompt builder. The composer gives the builder `runId` and `webhookUrl` via `ctx`.
- Telling the agent in the prompt to `curl ${webhookUrl}` with the result envelope. The agent owns its own back-pressure / retry loop while it runs.

## RFC alignment

| RFC primitive | this package | deferred to substrate |
|---|---|---|
| Session | hylo `runId` doubles as session id; deferred input substitutes for the durable event log | full per-session event log, replay, cursors |
| Orchestration | hylo's queue serves as `wake(session_id)` | claim-first wake, restart recovery |
| Harness | `AgentProvider` (`prepareSession` / `configureEnv` / `sendPrompt`) | replay-safe execution, claim fencing |
| Sandbox | `Sandbox` interface | durable lifecycle events |
| Resources | `Resource` discriminated union | durable mount records, artifact-by-digest |
| Tools | descriptor type only — providers expose tools internally | declared topology, frozen catalog, descriptor-only exposure |

The "deferred to substrate" column is what fireline's substrate gives you for free once we're on it.

## Endpoints

The cloud-claude provider defaults to `https://cloud-claude.smithery.workers.dev`. Override per-provider via the constructor's `baseUrl` option (accepts a literal string for now; can be promoted to a hylo handle later).
