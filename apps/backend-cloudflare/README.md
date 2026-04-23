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

This backend exposes bearer-protected deployment routes under
`/deployments`. Use `Authorization: Bearer $HYLO_API_KEY`.

Required Cloudflare environment variables:

```sh
CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_API_TOKEN=
CLOUDFLARE_DISPATCH_NAMESPACE=
```

Provision or update one tenant workflow deployment:

```sh
curl -X POST "$HYLO_BACKEND_URL/deployments" \
  -H "Authorization: Bearer $HYLO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"tenantId":"customer-123","deploymentId":"customer-123","label":"Customer 123","workflowApiUrl":"https://dispatch.example.com/customer-123/api/workflow","moduleCode":"export default { async fetch() { return new Response(\"ok\"); } }"}'
```

List tenant deployments with
`GET /deployments?tenantId=customer-123`, delete one deployment with
`DELETE /deployments/:deploymentId`, or delete all deployments for a tenant with
`DELETE /deployments?tenantId=customer-123`.

Provisioned deployments are also recorded in D1 for tenant-driven client routing:

```sh
GET /tenants/customer-123/deployments
GET /tenants/customer-123/workflows
```

The `/workflows` response matches the client workflow registry shape. The
client can load it by passing `?tenantId=customer-123` or by setting
`VITE_HYLO_TENANT_ID`. For cross-origin deployments, set
`VITE_HYLO_WORKFLOW_REGISTRY_URL` to a template such as
`https://api.example.com/tenants/{tenantId}/workflows`.

From the repo root, deploy this backend target with:

```sh
pnpm --filter backend-cloudflare deploy
```

## Preview Deployments

Use Cloudflare Workers Builds for branch and pull-request previews. Configure
the Workers project with:

- Root directory: repository root
- Build command: `pnpm --filter backend-cloudflare build`
- Deploy command: `pnpm --filter backend-cloudflare deploy`
- Non-production branch deploy command:
  `pnpm --filter backend-cloudflare exec wrangler versions upload`

`wrangler.toml` enables Worker preview URLs, so Cloudflare non-production
branch builds produce preview URLs without promoting the Worker to production.
