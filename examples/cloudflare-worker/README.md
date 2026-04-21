# Workflow Cloudflare Worker Example

Workflow server implemented as a Cloudflare Worker. It imports workflow code,
executes atoms in the Worker, and stores run data through the backend selected
by Hylo.

From this directory:

```sh
pnpm dev
```

To launch this workflow service with the client from the repo root:

```sh
pnpm hylo dev --backend ./apps/backend-node --workflow ./examples/cloudflare-worker ./apps/client
```

Deploy this workflow target with:

```sh
pnpm hylo deploy workflow ./examples/cloudflare-worker
```
