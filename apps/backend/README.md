# Hylo Backend Worker

This app is the Cloudflare Worker host for the backend API. Incoming Worker
requests are forwarded to a `BackendDurableObject`, which keeps the current
backend route surface compatible while moving the host architecture to Workers
and Durable Objects.

```sh
pnpm --filter backend dev
```

Local URLs:

- Portless: `https://api-worker.hylo.localhost`
- Direct Wrangler: `http://127.0.0.1:8788`

## Runtime modes

This backend is the shared queue and state host for two intended runtime modes.

### User-managed runtime

The user keeps workflow atom code in their own application, similar to
`examples/nextjs`, but uses this backend as the source of truth for runs, queue
items, events, and snapshots. In that mode the user runtime registers a
manifest, leases or receives queued work, executes atoms locally, and commits
step results back to this backend.

This requires a stable remote-executor protocol:

- workflow registration with version and manifest hashes
- queue lease, ack, fail, and retry operations
- idempotent step-result commits keyed by event id
- optimistic run-state versions
- result envelopes for resolved, skipped, waiting, blocked, and errored steps
- secret resolution through per-run bindings, not raw vault export

### Backend-managed uploaded workflows

The user uploads workflow atom code and this backend owns execution. Uploaded
source is transformed into a module Worker, validated through the
`WORKFLOW_LOADER` binding, stored by content hash, and executed through the same
Worker Loader binding when queue events are processed. The supervisor Durable
Object keeps ownership of queue and run state.

Remaining production work:

- TypeScript and dependency bundling for non-trivial uploads
- restricted outbound access by default
- no direct access to deployment secrets
- user-level secret vault entries mapped into logical workflow secret names per
  run
- version pinning so in-flight runs keep their original workflow code

## Current implementation

`apps/backend` accepts uploaded workflow source on `POST /workflows`, validates
its manifest in a Dynamic Worker, and executes run events in that Dynamic
Worker. The current source transformer supports the editor's `@workflow/core`
and `zod` imports with a small Worker-local schema implementation; a full
TypeScript/dependency bundling pipeline is still needed for arbitrary packages.

The old dynamic-source implementation lives in `examples/backend-node`. It is
useful for local comparison, but it relies on Node-style runtime source
evaluation and is not the Cloudflare production model.
