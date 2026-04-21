# Workflow Next.js Example

This example runs workflow atom code inside a Next.js route handler using:

- `@workflow/server` for the Hono API
- local workflow imports for execution
- a `backendApi` URL pointed at a Hylo-compatible backend

This represents the user-managed runtime model: workflow atoms are imported and
executed by the user's application instead of being uploaded to Hylo for
execution. Run state, queue items, events, and run documents are stored by the
backend configured with `HYLO_BACKEND_URL` while execution remains in Next.js.

For local backend development without Wrangler or Cloudflare, run
`apps/backend-node`; it uses PGlite under the hood and exposes the same runtime
API that this example consumes.

## Run

```sh
pnpm install
pnpm --filter backend-node dev
pnpm --filter workflow-nextjs-example dev
```

The Workflow API is mounted at:

```txt
https://nextjs.hylo.localhost/api/workflow
```

When run through Portless, the example derives the sibling backend URL from its
own `PORTLESS_URL`, so worktree-prefixed URLs point at the matching
`api.hylo` service. Set `HYLO_BACKEND_URL` explicitly to point at another
compatible backend.

## OAuth (Spotify, Notion)

OAuth runs through the Hylo broker (mounted at `${HYLO_BACKEND_URL}/oauth`),
not the worker. Provider client credentials live on the backend; the worker
only sees the resolved access token.

Worker env (`examples/nextjs/.env.local`):

```sh
HYLO_BACKEND_URL=http://localhost:8787
HYLO_API_KEY=local-dev-hylo-api-key   # must match backend-node
```

Backend env (`apps/backend-node`):

```sh
HYLO_API_KEY=local-dev-hylo-api-key
SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...
NOTION_CLIENT_ID=...
NOTION_CLIENT_SECRET=...
# In production also set HYLO_BACKEND_PUBLIC_URL so the broker registers
# a stable, externally-reachable redirect URI.
```

Register these redirect URIs in the provider dashboards:

```txt
http://localhost:8787/oauth/spotify/callback
http://localhost:8787/oauth/notion/callback   # Notion requires HTTPS — use Portless / a tunnel
```

When `HYLO_API_KEY` is unset and `NODE_ENV !== "production"`, both worker and
backend-node default to `local-dev-hylo-api-key` so the example just works
without coordinating env.

Useful requests:

```sh
curl https://nextjs.hylo.localhost/api/workflow/manifest

curl -X POST https://nextjs.hylo.localhost/api/workflow/runs \
  -H 'content-type: application/json' \
  -d '{"inputId":"lead","payload":{"name":"Ada","plan":"enterprise"}}'
```

The backend-node PGlite data directory defaults to `.hylo-backend-node` inside
`apps/backend-node`. Set `HYLO_BACKEND_NODE_DATA_DIR` to override it.
