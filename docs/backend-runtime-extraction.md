# Backend Runtime Extraction

## Goal

Split the Hylo backend into a shared, pure Hono API package plus thin runtime adapters.

The shared package owns the API contract, OpenAPI registration, auth routes, deployment routes, OAuth broker routes, runtime routes, and persistence wiring. Runtime-specific packages provide infrastructure strategies such as how workflow deployments are materialized.

This lets us run the same backend API in:

- Cloudflare Workers for production.
- Node.js for local development.
- Other runtimes later, without duplicating API behavior.

## Proposed Shape

```txt
packages/backend
  src/app.ts
  src/types.ts
  src/deployments/*
  src/auth/*

apps/backend-cloudflare
  src/index.ts
  wrangler.toml

apps/backend-node
  src/index.ts
  package.json
```

`packages/backend` exports a pure Hono app factory:

```ts
export function createBackendApp(options: BackendAppOptions): Hono {
  // Mounts auth, deployments, runtime, OAuth, OpenAPI.
}
```

Runtime apps only adapt environment and infrastructure:

```ts
// apps/backend-cloudflare/src/index.ts
export default {
  fetch(request, env) {
    return createBackendApp(cloudflareBackendOptions(env)).fetch(request);
  },
};
```

```ts
// apps/backend-node/src/index.ts
import { serve } from "@hono/node-server";

serve({
  fetch: createBackendApp(nodeBackendOptions(process.env)).fetch,
  port: Number(process.env.PORT ?? 8787),
});
```

## Deployment Strategy Interface

Deployment mechanics become pluggable behind one interface:

```ts
export type DeploymentBackend = {
  configured(): boolean;
  create(input: DeploymentCreateInput): Promise<DeploymentCreateResult>;
  get(deploymentId: string): Promise<unknown>;
  delete(deploymentId: string): Promise<void>;
  deleteMany(filter: DeploymentDeleteFilter): Promise<void>;
  fetchWorkflow?(deploymentId: string, request: Request): Promise<Response>;
};
```

Cloudflare implementation:

- Uploads bundled workflow module to Workers for Platforms Dispatch.
- Stores deployment metadata in Postgres.
- Dispatches `/workers/:deploymentId/*` via `env.DISPATCHER.get(deploymentId).fetch(...)`.

Node local implementation:

- Does not upload to Cloudflare.
- Stores deployment metadata in Postgres.
- Derives or accepts a local workflow URL.
- Dispatches `/workers/:deploymentId/*` with plain `fetch(workflowApiUrl)`.

The API route stays the same:

```txt
POST /deployments
GET /deployments
GET /deployments/:deploymentId
DELETE /deployments/:deploymentId
GET /tenants/me/workflows
```

Only the deployment backend changes.

## Local Development Model

Local dev runs:

```bash
pnpm dev
pnpm hylo deploy examples/cloudflare-worker --backend http://127.0.0.1:8787
```

The CLI does not need local-only flags.

The local Node backend can use a simple default mapping:

```txt
workflow-cloudflare-worker-example -> http://workflow-cloudflare-worker-example.localhost/api/workflow
```

If we use portless, this stays stable across changing ports. The backend only needs to know the deterministic hostname convention, not the actual port.

## Why This Is Simpler

The frontend only talks to the backend API. It does not know whether a workflow is local, Cloudflare Dispatch, or another runtime.

The CLI still uploads/registers a workflow through the same `/deployments` API. It does not need a local deploy command.

The Cloudflare Worker backend no longer needs local-development branching beyond its adapter. Local behavior lives in the Node adapter where local process networking is natural.

The OpenAPI spec stays generated from one Hono app, so clients and docs do not drift.

## Migration Plan

1. Move common backend code from `apps/backend-cloudflare/src` into `packages/backend/src`.
2. Replace Cloudflare globals in the common app with injected dependencies:
   - database
   - auth config
   - OAuth provider config
   - deployment backend
   - public backend URL resolver
3. Keep `apps/backend-cloudflare` as a thin adapter using the Cloudflare deployment backend.
4. Add `apps/backend-node` using `@hono/node-server` and the local deployment backend.
5. Point root `pnpm dev` at `apps/backend-node` for local backend development.
6. Keep Cloudflare backend deployment unchanged for prod.

## Open Questions

- Should local dev use the same PlanetScale Postgres branch by default, or a local Postgres URL?
- Should the local deployment backend require portless, or support both portless and explicit workflow URLs?
- Should `apps/backend-node` be kept private/dev-only, or treated as a supported self-hosting entrypoint?
- Should `hylo deploy` include the workflow id in the request body as the canonical local hostname source?

