# Hylo Client

The client is a workflow inspection UI for a single workflow server route. It
talks directly to the workflow API URL you configure — there is no fallback
proxy, so the URL must be reachable and CORS-enabled.

```sh
pnpm --filter client dev
```

## Choosing a backend

The backend URL is resolved at page load in this order:

1. The `?backendUrl=...` query string on `window.location` (highest priority).
2. The `VITE_BACKEND_URL` environment variable read at build/dev time.

If neither is provided, the client throws — there is no implicit default.

That makes it easy to switch between the Next.js and Cloudflare Worker examples
without rebuilding. Start whichever workflow server(s) you want, then point the
client at one:

```sh
# Default to the Next.js example
VITE_BACKEND_URL=https://nextjs.hylo.localhost/api/workflow \
  pnpm --filter client dev
```

```txt
# Override per page load
http://localhost:5173/?backendUrl=https://cf-worker.hylo.localhost/api/workflow
```

The backend API itself lives behind `apps/backend` or `apps/backend-node`;
workflow server routes pass that URL to `createWorkflow` so queue and state data
are read and written there.
