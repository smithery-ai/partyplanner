import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  ensureWorkflowPostgresSchema,
  type WorkflowPostgresMigrationDb,
} from "../src/migrate";
import { connectionUrl, defaultPgliteDataDir } from "./db-common";

const url = connectionUrl();

if (url) {
  const client = postgres(url, { max: 1 });
  try {
    await ensureWorkflowPostgresSchema(
      drizzlePostgres(client) as WorkflowPostgresMigrationDb,
    );
    console.log("Workflow Postgres schema is up to date.");
  } finally {
    await client.end();
  }
} else {
  const dataDir = defaultPgliteDataDir();
  const client = new PGlite(dataDir);
  try {
    await ensureWorkflowPostgresSchema(
      drizzlePglite({ client }) as WorkflowPostgresMigrationDb,
    );
    console.log(`Workflow PGlite schema is up to date at ${dataDir}.`);
  } finally {
    await client.close();
  }
}
