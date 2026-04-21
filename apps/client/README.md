# Client

React UI that inspects a single worker. Does not execute workflow code itself.

```sh
pnpm --filter client dev
```

In local Portless dev, `/api` proxies to the sibling worker at `nextjs.hylo.localhost/api/workflow`. Point at a different worker with `VITE_BACKEND_URL`:

```sh
VITE_BACKEND_URL=https://nextjs.hylo.localhost/api/workflow pnpm --filter client dev
```

The client talks to the **worker**, not the backend directly. The worker reads/writes durable state through the backend (`apps/backend` or `apps/backend-node`).
