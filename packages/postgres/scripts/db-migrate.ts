import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  ensureWorkflowPostgresSchema,
  type WorkflowPostgresMigrationDb,
} from "../src/migrate";
import { requireConnectionUrl } from "./db-common";

const client = postgres(requireConnectionUrl(), { max: 1 });

try {
  await ensureWorkflowPostgresSchema(
    drizzlePostgres(client) as WorkflowPostgresMigrationDb,
  );
  console.log("Workflow Postgres schema is up to date.");
} finally {
  await client.end();
}
