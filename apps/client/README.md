# Hylo Client

The client is a workflow inspection UI for a single workflow server route, such
as the Next.js example route. It does not directly execute workflow code or
accept source uploads.

```sh
pnpm --filter client dev
```

In local Portless development, the client can proxy to either workflow host:

- `?worker=nextjs` or `/api/nextjs` for the Next.js example
- `?worker=cloudflare` or `/api/cloudflare` for the Cloudflare Worker example

The default is Next.js. Set `VITE_WORKFLOW_WORKER=cloudflare` to change the
default, or set `VITE_WORKFLOW_API_URL` to point at a different workflow server
API:

```sh
VITE_WORKFLOW_API_URL=https://nextjs.hylo.localhost/api/workflow pnpm --filter client dev
```

The backend API itself lives behind `apps/backend` or `apps/backend-node`;
workflow server routes pass that URL to `createWorkflow` so queue and state data
are read and written there. The Backend dropdown can target `apps/backend-node`,
`apps/backend`, or a custom URL. The app targets are derived from the current
Portless URL when available, with direct local ports as the fallback. Pass the
backend URL through the request with `?backendUrl=...`, or set
`VITE_HYLO_BACKEND_URL` in the client environment so it is appended to workflow
requests.

The client also includes Worker and Backend dropdowns in the bottom-right
corner. Changing them updates the URL query string, so selected routing options
can be refreshed or shared.
