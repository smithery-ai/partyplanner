# Backend (Cloudflare)

Cloud flavor of the Hylo backend. A Cloudflare Worker that forwards requests to a `BackendDurableObject`, which persists run state, queue items, events, and run documents.

See the root README for the worker/backend architecture. This app is the managed half — it holds state and the mutation queue. Your worker (user code) passes this URL as `backendApi` to `createWorkflow`.

```sh
pnpm --filter backend dev
```

Local URLs:

- Portless: `https://api-worker.hylo.localhost`
- Direct Wrangler: `http://127.0.0.1:8788`

Routes:

- `/health` — health check
- `/runtime` — queue + state API (OpenAPI at `/runtime/openapi.json`)

Workflow code never runs here; the backend is stateless with respect to workflow source.
