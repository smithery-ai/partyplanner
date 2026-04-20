# Hylo Backend Node

Local Node/Hono implementation of the Hylo backend API. It stores workflow run
state, queue items, events, and run documents in PGlite so workflow server
routes can develop against a production-shaped persistence API without Wrangler
or the Cloudflare runtime.

```sh
pnpm --filter backend-node dev
```

The health route is mounted at:

```txt
http://localhost:8787/health
```

The queue/state API is mounted at:

```txt
http://localhost:8787/runtime
```

Workflow code does not upload to this service. Next.js routes, Cloudflare
Worker routes, or other user-owned workflow runtimes execute atoms and pass this
backend URL to `createWorkflow`.

By default, PGlite data is stored in `.hylo-backend-node` under this app
directory. Set `HYLO_BACKEND_NODE_DATA_DIR` to override it.
