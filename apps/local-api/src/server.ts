import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { startEmbeddedApp } from "./embedded-app.js";
import { Flamecast } from "./index.js";

const port = parsePort(process.env.PORT || process.env.LOCAL_API_PORT, 8788);
const hostname = process.env.HOST ?? "127.0.0.1";

const embeddedApp = startEmbeddedApp();
const flamecast = new Flamecast({ embeddedAppUrl: embeddedApp.url });

const server = serve(
  {
    fetch: flamecast.app.fetch,
    hostname,
    port,
  },
  (info) => {
    console.log(`Local API listening on http://${info.address}:${info.port}`);
  },
);

flamecast.attachWebSockets(server as Server);

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Local API shutting down (${signal})`);
  await embeddedApp.stop();
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

function parsePort(raw: string | undefined, fallback: number): number {
  const port = Number(raw ?? fallback);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback;
}
