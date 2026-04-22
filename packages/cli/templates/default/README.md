# __APP_NAME__

A Workflow app scaffolded by `@workflow/cli`.

## Develop

```bash
pnpm install
pnpm dev
```

`pnpm dev` runs `workflow dev`, which generates `.hylo/wrangler.json` from
`hylo.config.ts` and boots `wrangler dev`.

## Deploy

```bash
pnpm deploy
```

To deploy into a Cloudflare Workers for Platforms dispatch namespace, set
`dispatchNamespace` in `hylo.config.ts`.
