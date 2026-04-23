# Workflow Cloudflare Worker Example

Workflow server implemented as a Cloudflare Worker. It imports workflow code,
executes atoms in the Worker, and stores run data through the backend selected
by Hylo.

From this directory:

```sh
pnpm dev
```

To launch the backend, this worker, and the client from the repo root:

```sh
pnpm dev
```

Deploy this workflow target with:

```sh
pnpm deploy
```

The workflow deploy uses the customer-facing Hylo CLI and provisions the worker
through the backend deployments API.
