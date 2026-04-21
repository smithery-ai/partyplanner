# Hylo Backend Node

Node/Hono implementation of the Hylo backend API, backed by PGlite.

From this directory:

```sh
pnpm dev
```

From the repo root:

```sh
pnpm --filter backend-node dev
```

This routes through the Hylo launcher. The backend is selected as `node`, and
its backend URL is declared in `package.json`.
