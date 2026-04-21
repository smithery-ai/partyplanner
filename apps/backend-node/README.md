# Backend (Node)

Local flavor of the Hylo backend. Node + Hono on top of PGlite so you can develop a worker against a production-shaped persistence API without Wrangler or Cloudflare.

See the root README for the worker/backend architecture. This app pairs with a **local** worker (e.g. `examples/nextjs`).

```sh
pnpm --filter backend-node dev
```

Routes (default port `8787`):

- `GET  http://localhost:8787/health`
- `http://localhost:8787/runtime` — queue + state API (OpenAPI at `/runtime/openapi.json`)

PGlite data is stored in `.hylo-backend-node` under this directory. Override with `HYLO_BACKEND_NODE_DATA_DIR`.

Workflow code never runs here; the backend is stateless with respect to workflow source.
