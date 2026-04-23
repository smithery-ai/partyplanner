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

## Workers for Platforms provisioning

This backend exposes bearer-protected Workers for Platforms routes under
`/platform/workers`. Use `Authorization: Bearer $HYLO_API_KEY`.

Required Cloudflare environment variables:

```sh
CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_API_TOKEN=
CLOUDFLARE_DISPATCH_NAMESPACE=
```

Provision or update one tenant Worker:

```sh
curl -X POST "$HYLO_BACKEND_URL/platform/workers" \
  -H "Authorization: Bearer $HYLO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"tenantId":"customer-123","moduleCode":"export default { async fetch() { return new Response(\"ok\"); } }"}'
```

List tenant Workers with
`GET /platform/workers?tenantId=customer-123`, delete one Worker with
`DELETE /platform/workers/:scriptName`, or delete all Workers for a tenant with
`DELETE /platform/workers?tenantId=customer-123`.

From the repo root, deploy this backend target with:

```sh
pnpm hylo deploy remote backend.cloudflare
```
