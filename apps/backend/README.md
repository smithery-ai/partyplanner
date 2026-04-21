# Backend (Cloudflare)

Cloud flavor of the Hylo backend. A Cloudflare Worker that persists run state, queue items, events, run documents, and OAuth broker records in **D1**. Also hosts the OAuth broker at `/oauth`.

See the root README for the worker/backend architecture. This app is the managed half — it holds state, the mutation queue, and provider OAuth secrets. Your worker passes its URL as `backendApi` to `createWorkflow`.

```sh
pnpm --filter backend dev
```

Local URLs:

- Portless: `https://api-worker.hylo.localhost`
- Direct Wrangler: `http://127.0.0.1:8788`

## Database

```sh
pnpm --filter backend db:generate
pnpm --filter backend db:migrate
pnpm --filter backend db:studio
```

D1 schema and adapters live in `packages/cloudflare`. `db:generate` creates Drizzle SQL migrations in `packages/cloudflare/drizzle`. `db:migrate` applies them to the local D1 database through Wrangler. `db:studio` opens Drizzle Studio against the local Wrangler D1 SQLite file under `.wrangler/state`.

## Routes

- `/health` — health check
- `/runtime` — queue + state API (OpenAPI at `/runtime/openapi.json`)
- `/oauth` — curated OAuth broker

## OAuth broker

A provider (`spotify`, `notion`, …) is available only when its client ID and client secret are configured on the backend. `pnpm dev` writes `apps/backend/.dev.vars` for Wrangler from the current shell or Infisical env. Set e.g. `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` or `NOTION_CLIENT_ID` / `NOTION_CLIENT_SECRET` before starting dev, or edit `.dev.vars` directly.

Set `HYLO_API_KEY` to require a matching bearer token from workers. Set `HYLO_BROKER_BASE_URL` (or `HYLO_BACKEND_PUBLIC_URL`) in production so provider redirect URIs use the externally reachable backend URL.

Local redirect URIs:

- `https://api-worker.hylo.localhost/oauth/spotify/callback`
- `https://api-worker.hylo.localhost/oauth/notion/callback`

Workflow code never runs here; the backend is stateless with respect to workflow source.
