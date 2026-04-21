# Hylo Backend Worker

Cloudflare Worker host for the Hylo backend API. Incoming Worker requests are
forwarded to a `BackendDurableObject`, which persists run state, queue items,
events, and run documents.

```sh
pnpm --filter backend dev
```

Database workflow:

```sh
pnpm --filter backend db:generate
pnpm --filter backend db:migrate
pnpm --filter backend db:studio
```

The Worker stores its runtime data in the SQLite database attached to the
`BackendDurableObject`. Schema and adapter code lives in
`packages/cloudflare`. `db:migrate` starts a temporary local Wrangler instance
when one is not already running, triggers the Durable Object startup migration,
then shuts it down. `db:studio` opens Drizzle Studio against the local Wrangler
SQLite file under `.wrangler/state`.

Local URLs:

- Portless: `https://api-worker.hylo.localhost`
- Direct Wrangler: `http://127.0.0.1:8788`

The health route is mounted at `/health`. The queue/state API is mounted at
`/runtime`.

When `SPOTIFY_CLIENT_ID`/`SPOTIFY_CLIENT_SECRET` or
`NOTION_CLIENT_ID`/`NOTION_CLIENT_SECRET` are configured, the curated OAuth
broker is mounted at `/oauth`. Set `HYLO_API_KEY` to require a matching bearer
token from workflow runtimes. Set `HYLO_BROKER_BASE_URL`, or
`HYLO_BACKEND_PUBLIC_URL`, in production so provider redirect URIs use the
externally reachable backend URL.

Local redirect URIs:

- `https://api-worker.hylo.localhost/oauth/spotify/callback`
- `https://api-worker.hylo.localhost/oauth/notion/callback`

Workflow code does not upload to this backend. Next.js routes, Cloudflare Worker
routes, or other user-owned workflow runtimes execute atoms and interact with
this service by passing its URL to `createWorkflow`.
