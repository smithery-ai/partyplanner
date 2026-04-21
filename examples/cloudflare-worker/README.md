# Workflow Cloudflare Worker Example

This example runs workflow atom code inside a Cloudflare Worker using:

- `@workflow/server` for the Hono API
- local workflow imports for execution
- a `backendApi` URL pointed at a Hylo-compatible backend

Run state, queue items, events, and run documents are stored by the backend
configured with `HYLO_BACKEND_URL`, or by the `backendUrl` query parameter /
`x-hylo-backend-url` header on the workflow request.

The worker reads secrets from Worker `env` bindings. In production, configure an
Infisical Cloudflare Workers Sync for this Worker script so Infisical writes
`INCIDENT_PUBLISHER_TOKEN` into Cloudflare Worker secrets. The Worker will then
receive it as `env.INCIDENT_PUBLISHER_TOKEN`.

For local development, Wrangler can read `.dev.vars` or `.env` files directly.
If either file exists in this example directory, the dev script passes it to
Wrangler with `--env-file`. That means you can dump Infisical secrets into
`.dev.vars` or `.env` and let Wrangler load `INCIDENT_PUBLISHER_TOKEN`.

When run through Portless, the dev script still derives the sibling `api.hylo`
backend URL if `HYLO_BACKEND_URL` is not already set, and passes that derived
URL to Wrangler as a Worker variable. If no env file exists, the script also
falls back to bridging `INCIDENT_PUBLISHER_TOKEN` from `process.env`, which keeps
the root `pnpm dev` / `infisical run` path working.

## Run

```sh
pnpm install
pnpm --filter backend-node dev
pnpm --filter workflow-cloudflare-worker-example dev
```

The Workflow API is mounted at:

```txt
https://cloudflare-worker.hylo.localhost/api/workflow
```

Useful requests:

```sh
curl "https://cloudflare-worker.hylo.localhost/api/workflow/debug/env"

curl "https://cloudflare-worker.hylo.localhost/api/workflow/manifest?backendUrl=http://localhost:8787"

curl -X POST "https://cloudflare-worker.hylo.localhost/api/workflow/runs?backendUrl=http://localhost:8787" \
  -H 'content-type: application/json' \
  -d '{"inputId":"incidentAlert","payload":{"service":"checkout-api","severity":"sev2"}}'
```
