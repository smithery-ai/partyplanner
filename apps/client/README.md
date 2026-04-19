# Hylo Client

The client talks to the backend through `/api` in local development. Vite
rewrites that prefix and proxies requests to `apps/backend` by default.

```sh
pnpm --filter client dev
```

Set `VITE_BACKEND_URL` to point at a different backend:

```sh
VITE_BACKEND_URL=http://127.0.0.1:8788 pnpm --filter client dev
```

## Workflow creation

The UI currently keeps the existing "upload workflow" request shape so it can
work with both backend models:

- `examples/backend-node` can evaluate uploaded workflow source for local
  development
- `apps/backend` accepts the upload route for compatibility, but currently maps
  it to the bundled `@workflow/demo-workflow`

The intended production paths are:

- user-managed runtime: the user's app owns atom execution and uses Hylo backend
  queue/state APIs
- backend-managed uploaded workflows: the user uploads workflow atom code and
  Hylo executes a bundled, versioned Dynamic Worker
