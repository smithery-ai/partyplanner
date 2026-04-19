import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import {
  createPostgresWorkflowQueue,
  createPostgresWorkflowStateStore,
} from "@workflow/postgres";
import { createRemoteRuntimeServer } from "@workflow/remote";
import { drizzle } from "drizzle-orm/pglite";

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

  const app = createRemoteRuntimeServer({
    basePath: "/runtime",
    stateStore: createPostgresWorkflowStateStore(db),
    queue: createPostgresWorkflowQueue(db),
  });

  app.get("/health", (c) => c.json({ ok: true }));

  return app;
}
