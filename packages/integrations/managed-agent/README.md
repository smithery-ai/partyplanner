# @workflow/integrations-managed-agent

Generic managed-agent primitives for hylo workflows. One package, composable adapters. Primitive selection follows [Anthropic's Managed Agents framework](https://www.anthropic.com/engineering/managed-agents) — Session, Orchestration, Harness, Sandbox, Resources, Tools — narrowed to what hylo workflows need today.

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

| primitive | interface | what it abstracts |
|---|---|---|
| `AgentProvider` | `prepareSession`, `configureEnv`, `sendPrompt`, `abort?` | the LLM execution plane (the brain) — the harness loop that turns a prompt into agent effects |
| `Sandbox` | `provision`, `mount`, `stop?`, `cleanup?` | where tool calls execute (the hands) — local fs, Daytona, Docker, etc. |
| `Resource` | declarative `{ source_ref, mount_path }` | git repos, files, secrets, env vars made available to the agent by reference |
| `Tool` | `name` / `description` / `inputSchema` only | future — currently providers expose tools natively to the model |

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

## What's covered today vs. left to the substrate

| concern | covered here | left for hylo / future work |
|---|---|---|
| Session | hylo's `runId` doubles as session id; the workflow's deferred input substitutes for a durable event log | full per-session event log, replayable cursors, snapshot reads |
| Orchestration | hylo's run queue serves as `wake(session_id)` | claim-first wake, restart recovery, multi-worker fencing |
| Harness | `AgentProvider` (`prepareSession` / `configureEnv` / `sendPrompt`) | replay-safe execution, claim fencing on externally visible effects |
| Sandbox | `Sandbox` interface (provision / mount / stop / cleanup) | durable lifecycle events for audit |
| Resources | `Resource` discriminated union | durable mount records, artifact-by-digest references |
| Tools | descriptor type only — providers expose tools internally to the model today | declared topology, frozen tool catalog, descriptor-only exposure with credentials and transport resolved by reference |

## Endpoints

The cloud-claude provider defaults to `https://cloud-claude.smithery.workers.dev`. Override per-provider via the constructor's `baseUrl` option (accepts a literal string for now; can be promoted to a hylo handle later).
