import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export type WorkflowCloudflareDb = ReturnType<
  typeof createWorkflowCloudflareDb
>;

export function createWorkflowCloudflareDb(database: D1Database) {
  return drizzle(database, { schema });
}
