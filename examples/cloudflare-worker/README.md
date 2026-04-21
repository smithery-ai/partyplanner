# Workflow Cloudflare Worker Example

This example runs workflow atom code inside a Cloudflare Worker using:

- `@workflow/server` for the Hono API (mounted at `/api/workflow`)
- local workflow imports for execution
- a `backendApi` URL pointed at a Hylo-compatible backend

This mirrors `examples/nextjs` but swaps the Next.js route handler for a
`fetch()` export that runs on Cloudflare Workers (or any Workers-compatible
runtime). Run state, queue items, events, and run documents are stored by the
backend configured with `HYLO_BACKEND_URL` while execution remains in the
Worker.

For local backend development without Wrangler or Cloudflare, run
`apps/backend-node`; it uses PGlite under the hood and exposes the same runtime
API that this example consumes.

## Run

```sh
pnpm install
pnpm --filter backend-node dev
pnpm --filter workflow-cloudflare-worker-example dev
```

The Workflow API is mounted at:

```txt
https://cf-worker.hylo.localhost/api/workflow
```

When run through Portless, the example derives the sibling backend URL from its
own `PORTLESS_URL`, so worktree-prefixed URLs point at the matching `api.hylo`
service. Set `HYLO_BACKEND_URL` explicitly to point at another compatible
backend.

## Configuration

The Worker reads `HYLO_BACKEND_URL` from its env binding. The dev script forwards
the resolved value through `wrangler dev --var HYLO_BACKEND_URL:...`. For a
deployed Worker, set the same value via `wrangler secret put HYLO_BACKEND_URL`
or in the Workers dashboard.

Useful requests:

```sh
curl https://cf-worker.hylo.localhost/api/workflow/manifest

curl -X POST https://cf-worker.hylo.localhost/api/workflow/runs \
  -H 'content-type: application/json' \
  -d '{"inputId":"incidentAlert","payload":{"service":"checkout-api","severity":"sev2"}}'
```

## Pointing the client at this Worker

The client (`apps/client`) accepts a `?backendUrl=...` query string at runtime,
so you can switch between the Next.js example and this Worker without rebuilding:

```txt
http://localhost:5173/?backendUrl=https://cf-worker.hylo.localhost/api/workflow
```

See `apps/client/README.md` for details.
