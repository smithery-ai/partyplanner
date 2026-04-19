# Backend Node Example

This is the previous Node/Hono backend moved out of `apps/backend` so the app
slot can host the Cloudflare Worker implementation.

```sh
pnpm --filter workflow-backend-node-example dev
```

This legacy example is exposed through Portless at:

```txt
https://api-legacy.hylo.localhost
```

This example supports the legacy uploaded-source development flow. The client
can send workflow source to the backend, and the Node server can evaluate it to
create a workflow manifest and run atoms.

Do not treat this as the production Cloudflare execution model. The Worker
backend should support uploaded workflows through bundled, versioned Dynamic
Workers with explicit sandbox bindings, secret resolution, and run-state
ownership in the supervisor Durable Object.
