import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { Flamecast } from "./index.js";

const port = parsePort(process.env.PORT || process.env.LOCAL_API_PORT, 8788);
const hostname = process.env.HOST ?? "127.0.0.1";
const flamecast = new Flamecast();

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

function parsePort(raw: string | undefined, fallback: number): number {
  const port = Number(raw ?? fallback);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback;
}
