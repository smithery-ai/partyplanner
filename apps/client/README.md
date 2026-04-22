# Client

React UI that inspects a workflow server. It does not execute workflow code.

Use the root quickstart for the full local experience:

```sh
pnpm dev
```

To inspect the local profile environment:

```sh
pnpm hylo env
```

From this directory, `pnpm dev` starts the client with the local profile
dependencies it needs. The client talks to a worker; the worker reads and
writes durable state through the selected backend.

From the repo root, deploy the browser app after the workflow service:

```sh
pnpm hylo deploy remote workflow.cloudflareWorker
pnpm hylo deploy remote app.client
```

Hylo injects the workflow URL during the Vite build. This app deploys to
Vercel using the package-owned deploy script.
