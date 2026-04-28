import { serve } from "@hono/node-server";
import { createNodeBackendApp } from "@hylo/backend/node";

const port = parsePort(process.env.HYLO_BACKEND_PORT ?? process.env.PORT, 8787);
const hostname = process.env.HOST ?? "127.0.0.1";

const backend = createNodeBackendApp(process.env);
backend.start();

const server = serve(
  {
    fetch: backend.fetch,
    hostname,
    port,
  },
  (info) => {
    console.log(
      `Hylo backend listening on http://${info.address}:${info.port}`,
    );
  },
);

const shutdown = (signal: NodeJS.Signals) => {
  console.log(`Received ${signal}, shutting down`);
  backend.stop();
  server.close(() => process.exit(0));
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

function parsePort(raw: string | undefined, fallback: number): number {
  const port = Number(raw ?? fallback);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback;
}
