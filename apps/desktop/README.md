# Desktop

Electron example app that mirrors `apps/client` and uses the WorkOS desktop
AuthKit pattern from `workos/electron-authkit-example`: PKCE runs in the
Electron main process, the OAuth callback returns through a custom deep link,
and the renderer receives auth state through a preload bridge.

## Quick start

From the repo root:

```sh
pnpm install
pnpm dev:desktop
```

That starts the desktop shell against the production Hylo backend by default
(`https://backend.flamecast.dev`), using the WorkOS config discovered from that
backend. It also starts the local API used by desktop chat, but it does not use
the local example workflow as a fallback while pointed at the production
backend.

If you want to point the desktop app at a different backend:

```sh
VITE_HYLO_BACKEND_URL=https://api-worker.hylo.localhost pnpm dev:desktop
```

To explicitly run the local example workflow from the desktop shell:

```sh
VITE_HYLO_WORKFLOW=workflow-cloudflare-worker-example pnpm dev:desktop
```

## WorkOS setup

The desktop app expects WorkOS to be configured on the target Hylo backend.
It reads the public client config from `${VITE_HYLO_BACKEND_URL}/auth/client-config`.

Add this redirect URI in the WorkOS Dashboard for the same client:

```txt
hylo-auth://callback
```

Optional overrides:

```sh
MAIN_VITE_WORKOS_CLIENT_ID=client_123
MAIN_VITE_WORKOS_API_HOSTNAME=api.example.com
```

Those are mainly useful if you want to bypass backend config discovery.

## Scripts

```sh
pnpm --filter desktop dev
pnpm --filter desktop build
pnpm --filter desktop lint
```
