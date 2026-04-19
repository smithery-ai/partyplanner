# Hylo

## Local development

Install dependencies and start the Turbo dev graph:

```sh
pnpm install
pnpm dev
```

The dev servers run through the repository-local `portless` dependency, so no
global install is required. On first run, Portless may ask for `sudo` so it can
bind the HTTPS proxy on port 443 and trust its local development certificate.
The dev script prints this explanation before starting Portless.
Each app binds to the free port assigned by Portless, so parallel workspaces do
not collide on fixed framework ports.

Expected local URLs:

- Client: `https://hylo.localhost`
- Backend Worker: `https://api-worker.hylo.localhost`
- Node backend example: `https://api.hylo.localhost`

In git worktrees, Portless adds the worktree branch as a subdomain prefix so
parallel checkouts do not share routes.

To bypass Portless and use direct framework ports:

```sh
PORTLESS=0 pnpm dev
```

The Cloudflare Worker host lives in `apps/backend` and is the client default.
It runs the bundled demo workflow as a static workflow module because
request-time JavaScript source evaluation is not a Cloudflare Worker execution
model. The previous Node/Hono backend remains available in
`examples/backend-node` for dynamic source evaluation:

```sh
pnpm --filter workflow-backend-node-example dev
```
