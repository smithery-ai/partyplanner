# Hylo Backend Cloudflare

Cloudflare Worker implementation of the Hylo backend API, backed by D1.

From this directory:

```sh
pnpm db:migrate
pnpm dev
```

The app owns the Wrangler/D1 migration commands because the D1 binding and
`wrangler.toml` live here. The shared Cloudflare package owns the schema and
generated migration files.

From the repo root, deploy this backend target with:

```sh
pnpm hylo deploy remote backend.cloudflare
```
