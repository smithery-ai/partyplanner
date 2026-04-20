# Hylo Client

The client is a workflow inspection UI for a single workflow server route, such
as the Next.js example route. It does not directly execute workflow code or
accept source uploads.

```sh
pnpm --filter client dev
```

In local Portless development, `/api` proxies to the sibling
`nextjs.hylo.localhost` workflow route. Set `VITE_BACKEND_URL` to point at a
different workflow server API:

```sh
VITE_BACKEND_URL=https://nextjs.hylo.localhost/api/workflow pnpm --filter client dev
```

The backend API itself lives behind `apps/backend` or `apps/backend-node`;
workflow server routes pass that URL to `createWorkflow` so queue and
state data are read and written there.
