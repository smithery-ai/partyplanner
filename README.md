# Hylo

Hylo runs workflow servers against a backend API. Workflow servers own user code
and execute atoms; the backend stores run state, queue items, events, OAuth
handoffs, and run documents.

## Quickstart

```sh
pnpm install
pnpm dev
```

`pnpm dev` is the repo client launcher. It starts:

- the Node backend
- the Next.js workflow example
- the Vite client

The root `package.json` shows the exact Turbo graph: `client` plus the selected
workflow package. Hylo wraps that graph, starts the selected backend, and
injects `HYLO_BACKEND_URL`.

## Switching Targets

Use the same two flags when you need a different shape:

```sh
pnpm hylo dev --backend cloudflare --workflow nextjs -- <dev command>
pnpm hylo dev --backend node --workflow cloudflare-worker -- <dev command>
pnpm hylo dev --backend-url https://api.example.com --workflow nextjs -- <dev command>
```

For the repo client, `<dev command>` is a Turbo command that includes
`--filter=client` and one workflow package filter.

## Launcher Modes

- `hylo dev --backend <name|url> [--workflow <name>] -- <command>` is for local
  development.
- `hylo run --backend <name|url> -- <command>` is for a long-running workflow
  server against an already-running backend.
- `hylo exec --backend <name|url> -- <command>` is for one-off backend-scoped
  commands such as migrations.

`run` and `exec` do not take `--workflow`; the command after `--` is already
the thing being run. A future deploy command should keep the same split:
`hylo deploy --backend cloudflare --workflow cloudflare-worker`.

## Backends

- `node`: `apps/backend-node`, a Node/Hono backend backed by PGlite.
- `cloudflare`: `apps/backend-cloudflare`, a Cloudflare Worker backed by D1.

Backend apps declare their URL in `package.json` under `hylo.backend.url`. Apps
and examples declare their stable local URL under `hylo.dev.url`.

## Architecture

Hylo is a backend API plus user-owned workflow server routes:

- Workflow server routes import workflow code, execute atoms, validate inputs,
  and resolve secrets.
- The backend API persists run state, queue items, events, OAuth handoffs, and
  run documents.
- Workflow source is not uploaded to the backend API.

`examples/nextjs` and `examples/cloudflare-worker` are workflow servers. They
run workflow code and talk to whichever backend Hylo selected.
