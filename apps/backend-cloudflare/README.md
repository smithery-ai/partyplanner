# Hylo Backend Cloudflare

Cloudflare Worker implementation of the Hylo backend API, backed by Postgres.
In deployed environments it should use Cloudflare Hyperdrive for connection
pooling; local and preview environments can use `POSTGRES_URL`/`DATABASE_URL`
directly.

From this directory:

```sh
pnpm db:migrate:staging
pnpm db:migrate:prod
pnpm dev
```

## Local public callbacks

Webhook providers such as Slack need a public HTTPS URL even when the backend is
running locally. From the repo root, start the dev stack with:

```sh
pnpm dev -- --tunnel
```

The launcher starts `cloudflared tunnel --url http://127.0.0.1:$HYLO_BACKEND_PORT`
and exports the generated URL as `HYLO_BACKEND_TUNNEL_URL`. Backend code should
derive provider-facing URLs with `resolveBackendPublicUrl(env, requestOrigin)`;
that helper prefers the tunnel URL, then `HYLO_BACKEND_PUBLIC_URL`, then the
request origin.

For the backend-level ingress from PR 67, subscription creation should use that
public backend base URL when returning provider callback URLs such as:

```txt
https://<tunnel>.trycloudflare.com/webhooks/<provider>/<subscription>
```

The app delegates schema setup to `packages/postgres`. Configure one of:

- `HYPERDRIVE` binding in the Worker environment
- `POSTGRES_URL` or `DATABASE_URL` as a Worker secret or local env var
- `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` for `wrangler dev`

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

Provisioned deployments are also recorded in Postgres for tenant-driven client routing:

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
pnpm --filter backend-cloudflare run deploy
```

## Preview Deployments

Use Cloudflare Workers Builds for branch and pull-request previews. Configure
the Workers project with:

- Root directory: repository root
- Build command: `pnpm --filter backend-cloudflare build`
- Deploy command: `pnpm --filter backend-cloudflare run deploy`
- Non-production branch deploy command:
  ```sh
  ALIAS="$(echo "$WORKERS_CI_BRANCH" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g; s/^-*//; s/-*$//; s/--*/-/g' | cut -c1-40 | sed 's/-*$//')" && pnpm --filter backend-cloudflare exec wrangler versions upload --env preview --preview-alias "${ALIAS:-preview}"
  ```

`wrangler.toml` enables Worker preview URLs, so pull requests upload preview
versions without promoting the Worker to production. The `preview` Wrangler
environment uses the staging Hyperdrive database.
The aliased preview URL format is:

```txt
https://{branch}-hylo-backend-preview.smithery.workers.dev
```

where `{branch}` is the sanitized branch alias from the non-production deploy
command.
