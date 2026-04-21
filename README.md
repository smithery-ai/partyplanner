# Hylo

Hylo lets you write durable, human-in-the-loop workflows as a graph of values.
Workflow servers own user code and secrets; the backend stores run state, queue
items, events, OAuth handoffs, and run documents.

## Quickstart

```sh
pnpm install
pnpm dev
```

`pnpm dev` is the repo client launcher. It starts the Node backend, the Next.js
workflow example, and the Vite client. The exact Turbo graph lives in the root
`package.json`; Hylo wraps that graph, starts the selected backend, and injects
`HYLO_BACKEND_URL`.

## Workflow Model

Workflows are built from four primitives in `@workflow/core`:

```ts
input(name, schema) // data from the outside world
atom(fn, opts?) // derived value
action(fn, opts?) // side effect
secret(name, value) // env-backed value resolved on the worker
```

Inside any `atom` or `action`, `await get(otherAtom)` reads a value and
subscribes to it. `await requestIntervention({ schema })` pauses a run until a
human submits the requested value.

## Launcher

Use the same two flags when you need a different local or deployed shape:

```sh
pnpm hylo dev --backend cloudflare --workflow nextjs -- <dev command>
pnpm hylo dev --backend node --workflow cloudflare-worker -- <dev command>
pnpm hylo dev --backend-url https://api.example.com --workflow nextjs -- <dev command>
```

- `hylo dev --backend <name|url> [--workflow <name>] -- <command>` wraps local
  development commands.
- `hylo run --backend <name|url> -- <command>` wraps a long-running workflow
  server against an already-running backend.
- `hylo exec --backend <name|url> -- <command>` wraps one-off backend-scoped
  commands such as migrations.

`run` and `exec` do not take `--workflow`; the command after `--` is already
the thing being run. A future deploy command should keep the same split:
`hylo deploy --backend cloudflare --workflow cloudflare-worker`.

## Architecture

Hylo has three pieces:

- **Worker**: your workflow server. It imports workflow code, executes atoms and
  actions, validates inputs, and resolves secrets.
- **Backend**: the durable state manager and queue. It stores run state, events,
  run documents, and OAuth broker records. It does not store workflow source.
- **Client**: the React UI that points at a worker and visualizes its graph,
  pending inputs, interventions, and queue.

Backend and worker talk HTTP both directions, so both must be reachable by the
other. Local development usually pairs `backend-node` with a local worker.
Cloud deployments pair a deployed backend with a deployed worker.

## Monorepo Layout

```txt
apps/
  backend-cloudflare/  Cloudflare Worker backend + D1
  backend-node/        Node/Hono backend + PGlite
  client/              React UI (Vite)

examples/
  nextjs/              Workflow server example
  cloudflare-worker/   Workflow server example

packages/
  core/                atom, action, input, secret
  runtime/             scheduler, registry, executor
  server/              createWorkflow() HTTP routes
  remote/              worker/backend REST transport
  cloudflare/          D1 adapters and migrations
  postgres/            PGlite/Postgres adapters and schema
  oauth-broker/        backend-hosted OAuth broker
  frontend/            React workflow UI components
  integrations/        worker-side service integrations
```
