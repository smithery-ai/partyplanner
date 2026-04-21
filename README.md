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
- Backend Worker API: `https://api-worker.hylo.localhost`
- Node/PGlite backend API: `https://api.hylo.localhost`
- Next.js workflow server example: `https://nextjs.hylo.localhost`
- Cloudflare Worker workflow server example:
  `https://cloudflare-worker.hylo.localhost`

To bypass Portless and use direct framework ports:

```sh
PORTLESS=0 pnpm dev
```

## Architecture

Hylo is now shaped as a backend API plus workflow server routes:

- `apps/backend` is the Cloudflare Worker/D1 backend API.
- `apps/backend-node` is the local Node/PGlite backend API.
- Workflow code runs in user-owned server routes, such as `examples/nextjs`, or
  in Cloudflare Worker routes that import the workflow atoms directly.
- Workflow server routes pass a `backendApi` URL to `createWorkflow`.
  That backend API owns run state, queue items, events, and run documents.

Workflow source is not uploaded to the backend API. Browser clients and backend
services should not evaluate arbitrary workflow code. The server route that owns
the workflow code is responsible for importing atoms, executing queue events,
and committing state back through the backend API protocol.

## Runtime Protocol

The shared backend API stores:

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
pnpm --filter backend db:migrate
pnpm --filter backend dev
pnpm --filter workflow-nextjs-example dev
```

`examples/nextjs` imports workflow atoms directly and points `createWorkflow` at
`apps/backend` through `HYLO_BACKEND_URL`.
`examples/cloudflare-worker` provides the same workflow-server shape inside a
Cloudflare Worker.
