# Hylo Client

Workflow inspection UI. It does not execute workflow code or accept source
uploads.

Run it through Hylo:

```sh
pnpm dev
```

From the repo root:

```sh
pnpm --filter client dev
```

The dev script launches the client through Hylo. Hylo starts the selected local
backend and injects it through `HYLO_BACKEND_URL`.
