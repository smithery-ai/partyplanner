# Workflow Cloudflare Worker Example

Workflow server implemented as a Cloudflare Worker. It imports workflow code,
executes atoms in the Worker, and stores run data through the backend selected
by Hylo.

From this directory:

```sh
pnpm dev
```

Gmail workflows use Arcade for authorization. Set `ARCADE_API_KEY` in the worker
environment. The Hylo client passes the signed-in WorkOS user email to Arcade at
run time, so the example worker does not need a static user id.

In the Arcade dashboard, configure the custom user verifier URL to the Hylo
backend route exposed by the client. With the repo-level `pnpm dev`, use:

```text
https://hylo-client.localhost/api/arcade/user-verifier
```

If you bypass portless and open Vite directly, use:

```text
http://localhost:5173/api/arcade/user-verifier
```

For production, use the deployed client host:

```text
https://<client-host>/api/arcade/user-verifier
```

To launch the backend, this worker, and the client from the repo root:

```sh
pnpm dev
```

Deploy this workflow target with:

```sh
pnpm deploy
```

The workflow deploy uses the customer-facing Hylo CLI and provisions the worker
through the backend deployments API.
