# Workflow Next.js Example

This example runs a Workflow backend inside a Next.js route handler using:

- `@workflow/server` for the Hono API
- `@workflow/postgres` for separate state-store and queue adapters
- Drizzle with PGlite as the Postgres-compatible local database

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
