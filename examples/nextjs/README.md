# Workflow Next.js Example

Workflow server implemented as a Next.js route handler. It imports workflow code
locally, executes atoms in the Next.js process, and stores run data through the
backend selected by Hylo.

Run it through Hylo:

```sh
pnpm dev
```

Hylo starts the selected local backend and injects it through
`HYLO_BACKEND_URL`.

From the repo root:

```sh
pnpm --filter workflow-nextjs-example dev
```
