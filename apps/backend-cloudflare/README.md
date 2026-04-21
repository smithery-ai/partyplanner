# Hylo Backend Cloudflare

Cloudflare Worker implementation of the Hylo backend API, backed by D1.

From this directory:

```sh
pnpm db:migrate
pnpm dev
```

From the repo root:

```sh
pnpm --filter backend-cloudflare db:migrate
pnpm --filter backend-cloudflare dev
```

These scripts route through the Hylo launcher. The backend is selected as
`cloudflare`, and its backend URL is declared in `package.json`.

The app owns the Wrangler/D1 migration commands because the D1 binding and
`wrangler.toml` live here. The shared Cloudflare package owns the schema and
generated migration files.
