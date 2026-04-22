# Workflow Cloudflare Worker Example

Workflow server implemented as a Cloudflare Worker. It imports workflow code,
executes atoms in the Worker, and stores run data through the backend selected
by Hylo.

From this directory:

```sh
pnpm dev
```

To launch the full local profile from the repo root:

```sh
pnpm dev
```

Deploy this workflow target with:

```sh
pnpm hylo deploy remote workflow.cloudflareWorker
```

Hylo wires the deployed backend URL into the workflow deploy.
