# Next.js worker example

A **worker** (in Hylo terms — user code that hosts workflow atoms) implemented as a Next.js route handler using `@workflow/server`. Pair it with a local backend (`apps/backend-node`) via `HYLO_BACKEND_URL`.

Workflow code is imported and executed in this process. The backend only stores durable state — it never sees workflow source.

## Run

```sh
pnpm install
pnpm --filter backend-node dev
pnpm --filter workflow-nextjs-example dev
```

Worker API is mounted at:

```txt
https://nextjs.hylo.localhost/api/workflow
```

Under Portless, the worker derives the sibling backend URL from its own `PORTLESS_URL` (so worktree-prefixed URLs point at the matching `api.hylo` service). Override by setting `HYLO_BACKEND_URL` explicitly.

## Spotify OAuth

The `spotifyLogin` workflow demonstrates a dynamic intervention that opens Spotify OAuth, receives the callback, and resumes the waiting run. For a real Spotify app:

```sh
SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...
OAUTH_STATE_SECRET=...
NEXT_PUBLIC_APP_URL=https://nextjs.hylo.localhost
```

Register this redirect URI in the Spotify app settings:

```txt
https://nextjs.hylo.localhost/api/spotify/callback
```

For a non-Portless local server, use the origin where Next.js is reachable, e.g. `http://127.0.0.1:3000/api/spotify/callback`.

## Useful requests

```sh
curl https://nextjs.hylo.localhost/api/workflow/manifest

curl -X POST https://nextjs.hylo.localhost/api/workflow/runs \
  -H 'content-type: application/json' \
  -d '{"inputId":"lead","payload":{"name":"Ada","plan":"enterprise"}}'
```

The backend-node PGlite data directory defaults to `.hylo-backend-node` inside `apps/backend-node`. Override with `HYLO_BACKEND_NODE_DATA_DIR`.
