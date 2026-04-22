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

## WorkOS AuthKit

Set the WorkOS client ID before starting the app:

```sh
VITE_WORKOS_CLIENT_ID=client_... pnpm --filter client dev
```

Optional AuthKit settings:

```sh
VITE_WORKOS_API_HOSTNAME=auth.example.com
VITE_WORKOS_REDIRECT_URI=http://localhost:5173
VITE_WORKOS_DEV_MODE=true
```

In the WorkOS Dashboard, configure the client URL as an AuthKit Redirect URI,
configure `/login` on that same origin as the sign-in endpoint, and add the
client origin to the Authentication CORS allow list.

In local dev, Vite proxies `/user_management/*` to `https://api.workos.com`.
This keeps browser code-exchange requests same-origin while preserving WorkOS
as the upstream API.

From the repo root, deploy the browser app after the workflow service:

```sh
pnpm hylo deploy remote workflow.cloudflareWorker
pnpm hylo deploy remote app.client
```

Hylo injects the workflow URL during the Vite build. This app deploys to
Vercel using the package-owned deploy script.
