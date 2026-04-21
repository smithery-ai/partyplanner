# Workflow Cloudflare Worker Example

Workflow server implemented as a Cloudflare Worker. It imports workflow code
locally, executes atoms in the Worker, and stores run data through the backend
selected by Hylo.

Run it through Hylo:

```sh
pnpm dev
```

Hylo starts the selected local backend and injects it through
`HYLO_BACKEND_URL`.

From the repo root:

```sh
pnpm --filter workflow-cloudflare-worker-example dev
```
