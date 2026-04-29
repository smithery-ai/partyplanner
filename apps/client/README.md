# Client

React UI that inspects a workflow server. It does not execute workflow code.

Use the root quickstart for the full local experience:

```sh
pnpm dev
```

From this directory, `pnpm dev` starts only the Vite client. Start the backend
and workflow servers separately, or use the root `pnpm dev` Turbo task.

## WorkOS AuthKit

Set the WorkOS client ID in Vite for local dev:

```sh
VITE_WORKOS_CLIENT_ID=client_01KD3FTVXPFS0D95FFD7E2XH9K
```

The client prefers `VITE_WORKOS_CLIENT_ID` when it is set. If it is not set,
the app falls back to the Hylo backend `/auth/client-config` endpoint at
runtime. In local dev, Vite proxies that route to the backend worker started by
the root `pnpm dev` task.

Optional AuthKit settings:

```sh
VITE_WORKOS_API_HOSTNAME=auth.example.com
VITE_WORKOS_REDIRECT_URI=http://localhost:5173
VITE_WORKOS_DEV_MODE=true
```

In deployed environments, prefer setting `WORKOS_CLIENT_API_HOSTNAME` on the
Hylo backend to a first-party AuthKit API domain. If clients fall back to
`api.workos.com`, the browser app uses AuthKit dev-mode storage so reloads do
not immediately discard the session.

The sidebar organization switcher calls the backend `/me/organizations`
endpoint. Set `WORKOS_API_KEY` on the backend so it can read the signed-in
user's WorkOS organization memberships.

In the WorkOS Dashboard, configure the client URL as an AuthKit Redirect URI,
configure `/login` on that same origin as the sign-in endpoint, and add the
client origin to the Authentication CORS allow list.

In local dev, Vite proxies `/user_management/*` to `https://api.workos.com`.
This keeps browser code-exchange requests same-origin while preserving WorkOS
as the upstream API.

In local dev, the bottom-right Backend switcher controls whether the workflow
registry is loaded from the local backend Worker or from the hosted backend.
The hosted option defaults to `https://hylo-backend.smithery.workers.dev`; set
`VITE_HYLO_HOSTED_BACKEND_URL` to point it at a different backend.

For deployed environments, set the backend URL in Vercel:

```sh
VITE_HYLO_BACKEND_URL=https://hylo-backend.smithery.workers.dev
```

The app loads the signed-in user’s workflow registry from
`$VITE_HYLO_BACKEND_URL/tenants/me/workflows`. Deploy the app with Vercel using
the package-owned deploy script.

## Preview Deployments

Use Vercel's Git integration for branch and pull-request previews. Configure
the Vercel project with:

- Root directory: `apps/client`
- Framework preset: Vite
- Build command: from `vercel.json`
- Output directory: `dist`
- Preview environment variable:
  `VITE_HYLO_BACKEND_PREVIEW_URL_TEMPLATE=https://{branch}-hylo-backend.smithery.workers.dev`

For Preview deployments, the Vite build derives `VITE_HYLO_BACKEND_URL` from
`VITE_HYLO_BACKEND_PREVIEW_URL_TEMPLATE` and Vercel's `VERCEL_GIT_COMMIT_REF`.
The `{branch}` token is replaced with the same sanitized branch alias used by
the Cloudflare backend preview command.

Set `VITE_HYLO_BACKEND_URL` directly for Production:

```sh
VITE_HYLO_BACKEND_URL=https://hylo-backend.smithery.workers.dev
```
