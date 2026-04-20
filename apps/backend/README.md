# Hylo Backend Worker

Cloudflare Worker host for the Hylo DB API. Incoming Worker requests are
forwarded to a `BackendDurableObject`, which persists run state, queue items,
events, and run documents.

```sh
pnpm --filter backend dev
```

Local URLs:

- Portless: `https://api-worker.hylo.localhost`
- Direct Wrangler: `http://127.0.0.1:8788`

The health route is mounted at `/health`. The remote runtime queue/state API is
mounted at `/runtime`.

Workflow code does not upload to this backend. Next.js routes, Cloudflare Worker
routes, or other user-owned workflow runtimes execute atoms and interact with
this DB API through the remote runtime adapters.
