import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import {
  createPostgresWorkflowQueue,
  createPostgresWorkflowStateStore,
} from "@workflow/postgres";
import { createRemoteRuntimeServer } from "@workflow/remote";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import { cors } from "hono/cors";

export type BackendNodeAppOptions = {
  dataDir?: string;
};

export function createApp(options: BackendNodeAppOptions = {}) {
  const dataDir =
    options.dataDir ??
    process.env.HYLO_BACKEND_NODE_DATA_DIR ??
    "./.hylo-backend-node";
  mkdirSync(dirname(dataDir), { recursive: true });
  const client = new PGlite(dataDir);
  const db = drizzle({ client });

  const app = new Hono();
  app.use(
    "/*",
    cors({
      origin: "*",
      allowHeaders: ["Content-Type"],
      allowMethods: ["GET", "PUT", "POST", "OPTIONS"],
    }),
  );
  app.get("/health", (c) => c.json({ ok: true }));
  app.route(
    "/runtime",
    createRemoteRuntimeServer({
      basePath: "/",
      stateStore: createPostgresWorkflowStateStore(db),
      queue: createPostgresWorkflowQueue(db),
      cors: false,
    }),
  );

  return app;
}
