# Hylo Backend Worker

This app is the Cloudflare Worker host for the backend API. Incoming Worker
requests are forwarded to a `BackendDurableObject`, which keeps the current
backend route surface compatible while moving the host architecture to Workers
and Durable Objects.

```sh
pnpm --filter backend dev
```

Local URLs:

- Portless: `https://api-worker.hylo.localhost`
- Direct Wrangler: `http://127.0.0.1:8788`

The dynamic workflow editor remains backed by `examples/backend-node`; Workers
cannot evaluate runtime-authored JavaScript source with `new Function()` during
requests. This Worker currently maps workflow uploads to the bundled static demo
workflow from `@workflow/demo-workflow`; the next production path is static
bundle selection, manifest loading, or Dynamic Worker execution modes.
