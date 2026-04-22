# Workflow Next.js Example

Workflow server implemented as a Next.js route handler using
`@workflow/server`. It imports workflow code, executes atoms in the Next.js
process, and stores run data through the backend selected by Hylo.

From this directory:

```sh
pnpm dev
```

To launch the full local profile from the repo root:

```sh
pnpm dev
```

Worker API routes are mounted at `/api/workflow`, including `/health`,
`/manifest`, `/runs`, `/openapi.json`, and `/swagger`.
