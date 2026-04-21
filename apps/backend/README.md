# Hylo Backend Worker

Cloudflare Worker host for the Hylo backend API. The Worker persists run state,
queue items, events, run documents, and OAuth broker records in D1.

```sh
pnpm --filter backend dev
```

Database workflow:

```sh
pnpm --filter backend db:generate
pnpm --filter backend db:migrate
pnpm --filter backend db:studio
```

The D1 schema and adapters live in `packages/cloudflare`. `db:generate` creates
Drizzle SQL migrations in `packages/cloudflare/drizzle`. `db:migrate` applies
those migrations to the local D1 database through Wrangler. `db:studio` opens
Drizzle Studio against the local Wrangler D1 SQLite file under `.wrangler/state`.

Local URLs:

- Portless: `https://api-worker.hylo.localhost`
- Direct Wrangler: `http://127.0.0.1:8788`

The health route is mounted at `/health`. The queue/state API is mounted at
`/runtime`.

The curated OAuth broker is mounted at `/oauth`. A provider is available only
when its client ID and client secret are configured in the Worker environment:

```sh
cp apps/backend/.dev.vars.example apps/backend/.dev.vars
```

Then fill in `SPOTIFY_CLIENT_ID`/`SPOTIFY_CLIENT_SECRET` or
`NOTION_CLIENT_ID`/`NOTION_CLIENT_SECRET`. Set `HYLO_API_KEY` to require a
matching bearer token from workflow runtimes. Set `HYLO_BROKER_BASE_URL`, or
`HYLO_BACKEND_PUBLIC_URL`, in production so provider redirect URIs use the
externally reachable backend URL.

Local redirect URIs:

- `https://api-worker.hylo.localhost/oauth/spotify/callback`
- `https://api-worker.hylo.localhost/oauth/notion/callback`

Workflow code does not upload to this backend. Next.js routes, Cloudflare Worker
routes, or other user-owned workflow runtimes execute atoms and interact with
this service by passing its URL to `createWorkflow`.
