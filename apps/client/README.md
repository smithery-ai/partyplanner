# Client

React UI that inspects a workflow server. It does not execute workflow code.

Use the root quickstart for the full local experience:

```sh
pnpm dev
```

From this directory, `pnpm dev` runs only the Vite client and expects workflow
services to be running separately. The client talks to a worker; the worker
reads and writes durable state through the selected backend.
