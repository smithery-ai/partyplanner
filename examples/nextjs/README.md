# Workflow Next.js Example

This example runs a Workflow backend inside a Next.js route handler using:

- `@workflow/server` for the Hono API
- `@workflow/postgres` for separate state-store and queue adapters
- Drizzle with PGlite as the Postgres-compatible local database

This represents the user-managed runtime model: workflow atoms are imported and
executed by the user's application instead of being uploaded to Hylo for
execution.

The future hybrid variant keeps this execution ownership in the user's app, but
uses `apps/backend` for shared queue and run state. To get there, the local
state-store and queue adapters in this example would be replaced with remote
adapters that register workflow manifests, lease queue work, and commit
idempotent step results to the backend.

## Run

```sh
pnpm install
pnpm --filter workflow-nextjs-example dev
```

The Workflow API is mounted at:

```txt
http://localhost:3000/api/workflow
```

Useful requests:

```sh
curl http://localhost:3000/api/workflow/manifest

curl -X POST http://localhost:3000/api/workflow/runs \
  -H 'content-type: application/json' \
  -d '{"inputId":"lead","payload":{"name":"Ada","plan":"enterprise"}}'
```

The default PGlite data directory is `.workflow-data` inside this example
directory. Set `WORKFLOW_PGLITE_DATA_DIR` to override it.
