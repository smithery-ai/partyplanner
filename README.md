# Hylo

Hylo runs workflow servers against a shared backend API. The workflow server
owns user code and executes workflow atoms; the backend API stores run state,
queue items, events, OAuth handoffs, and run documents.

The `hylo` command is the entrypoint for running those servers. It launches your
process with `HYLO_BACKEND_URL` set to the selected backend:

```sh
hylo dev -- <server command>
```

Everything after `--` is your server bootstrap command. Package `dev` scripts
in this repo are thin wrappers around that shape.

## Quickstart

```sh
pnpm install
pnpm dev
```

The root `dev` script runs the client package's `hylo dev -- vite` command.
Hylo starts the default local backend, launches Vite, and injects
`HYLO_BACKEND_URL`.

## Launcher Commands

- `hylo dev -- <dev command>` starts a local dev server and injects
  `HYLO_BACKEND_URL`. If a package selects a named local backend, Hylo starts
  that backend too.
- `hylo run -- <server command>` launches a long-running server against an
  already-running or deployed backend.
- `hylo exec -- <one-off command>` runs migrations and other one-off tasks with
  the same backend environment.

Use `--backend node`, `--backend cloudflare`, or `--backend-url https://...`
when you need to override the package default. `HYLO_BACKEND` and
`HYLO_BACKEND_URL` provide the same override through environment variables.

## Backends

- `node`: `apps/backend-node`, a Node/Hono backend backed by PGlite.
- `cloudflare`: `apps/backend-cloudflare`, a Cloudflare Worker backed by D1.

Backend apps declare their Hylo backend URL in `package.json` under
`hylo.backend.url`. Apps and examples declare their local dev URL under
`hylo.dev.url`.

## Architecture

Hylo is a backend API plus user-owned workflow server routes:

- Workflow server routes import workflow code, execute atoms, validate inputs,
  and resolve secrets.
- The backend API persists run state, queue items, events, OAuth handoffs, and
  run documents.
- Workflow source is not uploaded to the backend API.

`examples/nextjs` and `examples/cloudflare-worker` are workflow servers. They
run workflow code and talk to whichever backend Hylo selected.
