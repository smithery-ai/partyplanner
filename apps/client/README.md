# Client

React UI that inspects a single worker. Does not execute workflow code itself.

```sh
pnpm --filter client dev
```

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

In Portless dev, AuthKit uses the current `*.localhost` hostname and Vite
proxies `/user_management/*` to `https://api.workos.com`. This keeps browser
code-exchange requests same-origin while preserving WorkOS as the upstream API.

In local Portless dev, `/api` proxies to the sibling worker at `nextjs.hylo.localhost/api/workflow`. Point at a different worker with `VITE_BACKEND_URL`:

```sh
VITE_BACKEND_URL=https://nextjs.hylo.localhost/api/workflow pnpm --filter client dev
```

The client talks to the **worker**, not the backend directly. The worker reads/writes durable state through the backend (`apps/backend` or `apps/backend-node`).
