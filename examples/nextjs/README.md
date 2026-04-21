# Workflow Next.js Example

This example runs workflow atom code inside a Next.js route handler using:

- `@workflow/server` for the Hono API
- local workflow imports for execution
- a `backendApi` URL pointed at a Hylo-compatible backend

This represents the user-managed runtime model: workflow atoms are imported and
executed by the user's application instead of being uploaded to Hylo for
execution. Run state, queue items, events, and run documents are stored by the
backend configured with `HYLO_BACKEND_URL` while execution remains in Next.js.

For local backend development, run `apps/backend`; it uses Wrangler with a local
D1 database and exposes the runtime API that this example consumes.

## Run

```sh
pnpm install
pnpm --filter backend db:migrate
pnpm --filter backend dev
pnpm --filter workflow-nextjs-example dev
```

The Workflow API is mounted at:

```txt
https://nextjs.hylo.localhost/api/workflow
```

When run through Portless, the example derives the sibling backend URL from its
own `PORTLESS_URL`, so worktree-prefixed URLs point at the matching
`api-worker.hylo` service. Set `HYLO_BACKEND_URL` explicitly to point at
another compatible backend.

## OAuth (Spotify, Notion)

OAuth runs through the Hylo broker (mounted at `${HYLO_BACKEND_URL}/oauth`),
not the worker. Provider client credentials live on the backend; the worker
only sees the resolved access token.

Worker env (`examples/nextjs/.env.local`):

```sh
HYLO_BACKEND_URL=http://127.0.0.1:8788
HYLO_API_KEY=local-dev-hylo-api-key   # must match backend
```

Backend Worker env:

```sh
HYLO_API_KEY=local-dev-hylo-api-key
SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...
NOTION_CLIENT_ID=...
NOTION_CLIENT_SECRET=...
HYLO_BACKEND_PUBLIC_URL=https://api-worker.hylo.localhost
```

The provider credentials must be visible to `pnpm dev` or
`pnpm --filter backend dev`, not only to the Next.js process. The backend dev
script writes `apps/backend/.dev.vars` for Wrangler from that environment. If
credentials are missing, `/oauth/:provider/start` returns `unknown_provider`.

Register these redirect URIs in the provider dashboards:

```txt
http://127.0.0.1:8788/oauth/spotify/callback
http://127.0.0.1:8788/oauth/notion/callback   # Notion requires HTTPS - use Portless / a tunnel
```

When `HYLO_API_KEY` is unset and `NODE_ENV !== "production"`, both worker and
backend default to `local-dev-hylo-api-key` so the example just works
without coordinating env.

Useful requests:

```sh
curl https://nextjs.hylo.localhost/api/workflow/manifest

curl -X POST https://nextjs.hylo.localhost/api/workflow/runs \
  -H 'content-type: application/json' \
  -d '{"inputId":"lead","payload":{"name":"Ada","plan":"enterprise"}}'
```

The local backend D1 database is stored under `apps/backend/.wrangler/state`.
