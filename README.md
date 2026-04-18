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

Expected local URLs:

- Client: `https://hylo.localhost`
- Backend: `https://api.hylo.localhost`

In git worktrees, Portless adds the worktree branch as a subdomain prefix so
parallel checkouts do not share routes.

To bypass Portless and use direct framework ports:

```sh
PORTLESS=0 pnpm dev
```
