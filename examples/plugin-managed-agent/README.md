# Plugin example — managed-agent

Reference example for consuming a third-party hylo plugin. The plugin (`@smithery/hylo-managed-agent`) lives in [`smithery-ai/hylo-plugins`](https://github.com/smithery-ai/hylo-plugins) and is installed here directly from its GitHub Release tarball — no npm registry, no in-tree package.

## What this example proves

A plugin authored entirely outside the hylo monorepo can be consumed by a hylo workflow with no special integration: peer-deps resolve through the workflow's own dependency tree, and the plugin's `atom()` / `action()` calls register against hylo's `globalRegistry` exactly as in-tree integrations do.

## How the install works

`package.json` pins the plugin to a Release tarball URL:

```json
"@smithery/hylo-managed-agent":
  "https://github.com/smithery-ai/hylo-plugins/releases/download/managed-agent-v0.1.1/smithery-hylo-managed-agent-0.1.1.tgz"
```

pnpm fetches the tarball and verifies the content hash. `pnpm-lock.yaml` records the exact hash so installs are reproducible regardless of whether the tag later moves. The plugin declares `@workflow/core`, `@workflow/integrations-oauth`, and `zod` as **peer dependencies** — this example provides all three via its own `workspace:*` deps to the in-tree hylo packages, so the plugin's imports resolve at install time.

## What the workflow does

A single managed-agent dispatch:

```
   input: ticket  ──►  action: investigate.dispatch  ──►  cloud-claude session
                                                              │
                       input.deferred: ticketResult   ◄───── webhook curl
                                          │
                                          ▼
                              atom: investigate.report
```

The agent reads the public README of a named repo and posts a one-sentence digest back via the workflow webhook. Trivial on purpose — the example is about **plugin consumption**, not investigation depth.

## Running

```sh
pnpm install
pnpm --dir ../.. hylo dev examples/plugin-managed-agent
```

Bind `AGENT_GITHUB_PAT` in the worker env. Trigger via the hylo client UI or `POST /runs` with `inputId: "ticket"`.

## Authoring your own plugin

See the [plugin authoring contract](https://github.com/smithery-ai/hylo-plugins#authoring-contract) at `smithery-ai/hylo-plugins`. Plugins are independently-versioned packages that import from `@workflow/core` (as a peer dep), compose hylo's primitives, and ship via per-package GitHub Release tarballs.
