# Hylo

## Local development

Install dependencies and start the Turbo dev graph:

```sh
pnpm install
pnpm dev
```

The dev servers run through the repository-local `portless` dependency, so no
global install is required. On first run, Portless may ask for `sudo` so it can
bind the HTTPS proxy on port 443 and trust its local development certificate.
The dev script prints this explanation before starting Portless.
Each app binds to the free port assigned by Portless, so parallel workspaces do
not collide on fixed framework ports.

Expected local URLs:

- Client: `https://hylo.localhost`
- Backend Worker: `https://api-worker.hylo.localhost`
- Node backend example: `https://api.hylo.localhost`

In git worktrees, Portless adds the worktree branch as a subdomain prefix so
parallel checkouts do not share routes.

To bypass Portless and use direct framework ports:

```sh
PORTLESS=0 pnpm dev
```

The Cloudflare Worker host lives in `apps/backend` and is the client default.
Uploaded workflow source is validated and executed through a Worker Loader
Dynamic Worker, while the backend Durable Object owns queue state, run state,
events, and snapshots. The previous Node/Hono backend remains available in
`examples/backend-node` for local comparison:

```sh
pnpm --filter workflow-backend-node-example dev
```

## Hybrid runtime model

Hylo is intended to support two runtime modes behind the same queue, state, and
run-inspection API.

### User-managed workflow runtime

In this mode, the user owns the workflow code and the process that executes it.
The `examples/nextjs` package is the closest local example: the application
imports the workflow atoms directly and runs the Workflow server inside its own
Next.js route handler.

The hybrid version of this model moves queue and run state into `apps/backend`
while leaving atom execution in the user's application:

- the user app publishes a workflow manifest and version to the backend
- `apps/backend` owns run creation, queue items, events, snapshots, and
  optimistic state commits
- the user runtime leases or receives queued step events, executes local atom
  code, and commits the result back to the backend
- backend state remains the source of truth for graph status, waiters, retries,
  idempotency, and audit history

This keeps private application code inside the user's app while still giving
Hylo one shared backend for orchestration, queue visibility, persistence, and
the client UI.

To make this reliable, the backend/runtime protocol needs:

- versioned workflow registration with a stable manifest hash
- a queue leasing API with ack/fail/retry semantics
- idempotent event and step-result commits keyed by event id
- optimistic state versions so concurrent workers cannot overwrite run state
- explicit result envelopes for resolved, skipped, waiting, blocked, and errored
  step outcomes
- a secret resolver contract so workflow code asks for logical secret names
  without receiving the user's whole vault
- compatibility tests that run the same workflow through in-process, Next.js,
  and remote-backend queue/state adapters

### Backend-managed uploaded workflows

In this mode, the user creates a workflow by uploading workflow atom code to
`apps/backend`. The backend owns both orchestration and execution.

The production Cloudflare path for this should use Dynamic Workers rather than
`eval` or `new Function()` inside the main Worker:

- accept uploaded workflow source or a bundled workflow module
- compile/bundle TypeScript and npm dependencies before execution
- compute a content hash and store source, bundle, manifest, and metadata by
  workflow version
- load the bundle through a Cloudflare Worker Loader binding
- execute workflow code in a sandbox with narrow bindings
- keep run state and queue ownership in the supervisor Durable Object

Uploaded workflow execution needs additional guardrails:

- manifest validation before a workflow version can be activated
- resource limits, timeouts, and deterministic retry behavior
- restricted outbound network access by default
- no direct access to deployment secrets
- per-run secret bindings from logical workflow secret names to user vault
  entries
- clear version pinning so existing runs continue on the workflow version they
  started with

Current status: `apps/backend` accepts uploaded workflow source, validates it in
a Dynamic Worker, and executes queue events through the Worker Loader binding.
The current transformer covers the editor's `@workflow/core` and `zod` import
shape; full TypeScript and dependency bundling is still future work. The legacy
dynamic-source implementation remains in `examples/backend-node` for
development and comparison.
