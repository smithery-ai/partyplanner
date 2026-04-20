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
Each app binds to the free port assigned by Portless, so parallel workspaces do
not collide on fixed framework ports.

Expected local URLs:

- Client: `https://hylo.localhost`
- Backend Worker DB API: `https://api-worker.hylo.localhost`
- Node/PGlite DB API: `https://api.hylo.localhost`
- Next.js workflow server example: `https://nextjs.hylo.localhost`

To bypass Portless and use direct framework ports:

```sh
PORTLESS=0 pnpm dev
```

## Architecture

Hylo is now shaped as a DB API plus workflow server routes:

- `apps/backend` is the Cloudflare Durable Object DB API.
- `apps/backend-node` is the local Node/PGlite DB API.
- Workflow code runs in user-owned server routes, such as `examples/nextjs`, or
  in Cloudflare Worker routes that import the workflow atoms directly.
- Workflow server routes use `@workflow/remote` adapters to store run state,
  queue items, events, and run documents in the DB API.

Workflow source is not uploaded to the DB API. Browser clients and backend DB
services should not evaluate arbitrary workflow code. The server route that owns
the workflow code is responsible for importing atoms, executing queue events,
and committing state back through the remote runtime protocol.

## Runtime Protocol

The shared DB API stores:

- optimistic run state versions
- queue items with claim, complete, and fail operations
- run events
- published run documents and summaries

The workflow server route owns:

- workflow registration/manifest for its route
- atom execution
- input validation
- result publication
- any secret resolution policy needed by that workflow

The Next.js example is the primary local integration:

```sh
pnpm --filter backend-node dev
pnpm --filter workflow-nextjs-example dev
```

`examples/nextjs` imports workflow atoms directly and points its remote
state/queue adapters at `apps/backend-node` through `HYLO_BACKEND_URL`.
