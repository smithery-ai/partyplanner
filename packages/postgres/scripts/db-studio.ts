import { spawn } from "node:child_process";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import {
  ensureWorkflowPostgresSchema,
  type WorkflowPostgresMigrationDb,
} from "../src/migrate";
import {
  connectionUrl,
  defaultPgliteDataDir,
  findFreePort,
  packageDir,
} from "./db-common";

const passthroughArgs = process.argv.slice(2).filter((arg) => arg !== "--");
let url = connectionUrl();
let pglite: PGlite | undefined;
let socketServer: PGLiteSocketServer | undefined;

if (!url) {
  const dataDir = defaultPgliteDataDir();
  const port = await findFreePort();
  pglite = new PGlite(dataDir);
  await ensureWorkflowPostgresSchema(
    drizzlePglite({ client: pglite }) as WorkflowPostgresMigrationDb,
  );
  socketServer = new PGLiteSocketServer({
    db: pglite,
    host: "127.0.0.1",
    port,
  });
  await socketServer.start();
  url = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;
  console.log(`Started PGlite socket for Drizzle Studio at ${dataDir}.`);
}

const child = spawn(
  "pnpm",
  [
    "exec",
    "drizzle-kit",
    "studio",
    "--config",
    join(packageDir, "drizzle.config.ts"),
    ...passthroughArgs,
  ],
  {
    cwd: packageDir,
    stdio: "inherit",
    env: {
      ...process.env,
      DATABASE_URL: url,
      POSTGRES_URL: url,
      PGSSLMODE: "disable",
    },
  },
);

let stopping = false;

async function stop(exitCode: number): Promise<never> {
  if (stopping) process.exit(exitCode);
  stopping = true;
  await socketServer?.stop();
  await pglite?.close();
  process.exit(exitCode);
}

process.on("SIGINT", () => {
  child.kill("SIGINT");
  void stop(130);
});

process.on("SIGTERM", () => {
  child.kill("SIGTERM");
  void stop(143);
});

child.on("exit", (code, signal) => {
  if (signal === "SIGINT") void stop(130);
  else if (signal === "SIGTERM") void stop(143);
  else void stop(code ?? 0);
});
