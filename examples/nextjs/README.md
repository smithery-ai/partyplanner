# Workflow Next.js Example

Workflow server implemented as a Next.js route handler using
`@workflow/server`. It imports workflow code, executes atoms in the Next.js
process, and stores run data through the backend selected by Hylo.

From this directory:

```sh
pnpm dev
```

To launch this workflow service with the client from the repo root:

```sh
pnpm hylo dev --backend ./apps/backend-node --workflow ./examples/nextjs ./apps/client
```

Deploy this workflow target with:

```sh
pnpm hylo deploy workflow ./examples/nextjs
```

Worker API routes are mounted at `/api/workflow`, including `/health`,
`/manifest`, `/runs`, `/openapi.json`, and `/swagger`.
