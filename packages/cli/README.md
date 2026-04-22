# @workflow/cli

The end-user CLI for Workflow apps. Scaffold a new project, run it against a
local Cloudflare Worker, and deploy to Cloudflare Workers (including Workers for
Platforms dispatch namespaces).

## Quickstart

```bash
npx @workflow/cli init my-app
cd my-app
pnpm install
pnpm dev
```

## Commands

- `workflow init <name>` — scaffold a new app in `./<name>`.
- `workflow dev [...]` — generate `.hylo/wrangler.json` and run `wrangler dev`.
- `workflow deploy [...]` — generate `.hylo/wrangler.json` and run `wrangler deploy`.
  If `dispatchNamespace` is set in `hylo.config.ts`, deploys into that Workers
  for Platforms namespace.

Extra args are forwarded to `wrangler` — e.g. `workflow dev --port 8799`.

## Config

Projects are configured in `hylo.config.ts`:

```ts
import { defineConfig } from "@workflow/cli";

export default defineConfig({
  name: "my-app",
  main: "src/index.ts",
  compatibilityDate: "2026-04-19",
  vars: { HYLO_BACKEND_URL: "https://backend.example.com" },
  dispatchNamespace: "my-namespace", // optional, enables Workers for Platforms
});
```

The CLI owns the generated `wrangler.json` — it's written to `.hylo/` (gitignored)
on every `dev`/`deploy`. Users should never hand-edit `.hylo/wrangler.json`.
