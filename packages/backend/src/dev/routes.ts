import type { OpenAPIHono } from "@hono/zod-openapi";
import {
  deletePostgresDatabaseData,
  type WorkflowPostgresDb,
} from "@workflow/postgres";
import type { BackendAppEnv } from "../types";

export function mountDevApi(
  app: OpenAPIHono,
  db: WorkflowPostgresDb,
  env: BackendAppEnv,
) {
  app.delete("/dev/database", async (c) => {
    if (!isLocalDevRequest(c.req.url, env)) {
      return c.json({ message: "Not found" }, 404);
    }
    const result = await deletePostgresDatabaseData(db);
    return c.json({ ok: true, ...result });
  });
}

function isLocalDevRequest(rawUrl: string, env: BackendAppEnv): boolean {
  if (env.NODE_ENV === "production") return false;
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local")
    );
  } catch {
    return false;
  }
}
