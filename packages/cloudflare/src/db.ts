import { drizzle } from "drizzle-orm/durable-sqlite";
import * as schema from "./schema";

export type WorkflowCloudflareDb = ReturnType<
  typeof createWorkflowCloudflareDb
>;

export function createWorkflowCloudflareDb(storage: DurableObjectStorage) {
  return drizzle(storage, { schema });
}
