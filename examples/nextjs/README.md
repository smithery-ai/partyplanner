# Next.js worker example

A **worker** (in Hylo terms — user code that hosts workflow atoms) implemented as a Next.js route handler using `@workflow/server`. Pair it with the Cloudflare backend (`apps/backend`, run locally through Wrangler) via `HYLO_BACKEND_URL`.

Workflow code is imported and executed in this process. The backend only stores durable state and brokers OAuth — it never sees workflow source.

## Run

```sh
pnpm install
pnpm --filter backend db:migrate
pnpm --filter backend dev
pnpm --filter workflow-nextjs-example dev
```

Worker API is mounted at:

```txt
https://nextjs.hylo.localhost/api/workflow
```

The same Hono app exposes generated API docs:

```txt
https://nextjs.hylo.localhost/api/workflow/openapi.json
https://nextjs.hylo.localhost/api/workflow/swagger
```

Under Portless, the worker derives the sibling backend URL from its own `PORTLESS_URL` (so worktree-prefixed URLs point at the matching `api-worker.hylo` service). Override by setting `HYLO_BACKEND_URL` explicitly.

## OAuth (Spotify, Notion)

OAuth runs through the Hylo broker (mounted at `${HYLO_BACKEND_URL}/oauth`), not the worker. Provider client credentials live on the backend; the worker only sees the resolved access token.

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

Provider credentials must be visible to `pnpm dev` or `pnpm --filter backend dev`, not only the Next.js process. The backend dev script writes `apps/backend/.dev.vars` for Wrangler from that environment. If credentials are missing, `/oauth/:provider/start` returns `unknown_provider`.

Register these redirect URIs in the provider dashboards:

```txt
http://127.0.0.1:8788/oauth/spotify/callback
http://127.0.0.1:8788/oauth/notion/callback   # Notion requires HTTPS — use Portless or a tunnel
```

When `HYLO_API_KEY` is unset and `NODE_ENV !== "production"`, both worker and backend default to `local-dev-hylo-api-key`, so the example just works without coordinating env.

## Useful requests

```sh
curl https://nextjs.hylo.localhost/api/workflow/manifest

curl https://nextjs.hylo.localhost/api/workflow/openapi.json

curl -X POST https://nextjs.hylo.localhost/api/workflow/runs \
  -H 'content-type: application/json' \
  -d '{"inputId":"lead","payload":{"name":"Ada","plan":"enterprise"}}'
```

The local backend D1 database is stored under `apps/backend/.wrangler/state`.
