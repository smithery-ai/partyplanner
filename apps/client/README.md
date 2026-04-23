# Client

React UI that inspects a workflow server. It does not execute workflow code.

Use the root quickstart for the full local experience:

```sh
pnpm dev
```

From this directory, `pnpm dev` starts only the Vite client. Start the backend
and workflow servers separately, or use the root `pnpm dev` Turbo task.

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
- Preview environment variable: `VITE_HYLO_BACKEND_URL`

Set `VITE_HYLO_BACKEND_URL` in Vercel's Preview environment to the backend
preview origin you want the app to use. Vercel automatically creates preview
deployments for non-production branches and pull requests.
