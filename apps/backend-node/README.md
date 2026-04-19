# Hylo Backend Node

Local Node/Hono implementation of the Hylo runtime backend contract. It stores
workflow run state, queue items, events, and run documents in PGlite so user apps
can develop against a production-shaped backend without Wrangler or the
Cloudflare runtime.

```sh
pnpm --filter backend-node dev
```

The runtime API is mounted at:

```txt
http://localhost:8787/runtime
```

By default, PGlite data is stored in `.hylo-backend-node` under this app
directory. Set `HYLO_BACKEND_NODE_DATA_DIR` to override it.
