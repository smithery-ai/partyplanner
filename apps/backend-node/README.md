# Backend Node

Local Hylo backend implemented with Node, Hono, and PGlite. It provides the same
state and queue API shape as the Cloudflare backend without requiring Wrangler.

From this directory:

```sh
pnpm dev
```

Schema tasks are package-owned:

```sh
pnpm db:migrate
pnpm db:studio
```

PGlite data is stored in `.hylo-backend-node` under this directory. Override it
with `HYLO_BACKEND_NODE_DATA_DIR`.

Workflow code never runs here; the backend is stateless with respect to
workflow source.
