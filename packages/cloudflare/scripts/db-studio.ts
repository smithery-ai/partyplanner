import { spawn } from "node:child_process";
import { join } from "node:path";
import { findLocalD1SqliteFile, packageDir } from "./db-common";

const sqliteFile = findLocalD1SqliteFile();

if (!sqliteFile) {
  throw new Error(
    "No local D1 SQLite file was found under apps/backend-cloudflare/.wrangler/state. From apps/backend-cloudflare, run pnpm db:migrate once, then try pnpm db:studio again.",
  );
}

console.log(`Opening Drizzle Studio for ${sqliteFile}`);

const child = spawn(
  "pnpm",
  [
    "exec",
    "drizzle-kit",
    "studio",
    "--config",
    join(packageDir, "drizzle.studio.config.ts"),
  ],
  {
    cwd: packageDir,
    stdio: "inherit",
    env: {
      ...process.env,
      SQLITE_FILE: sqliteFile,
    },
  },
);

const exitCode = await new Promise<number>((resolve) => {
  child.on("exit", (code, signal) => {
    if (signal === "SIGINT") resolve(130);
    else if (signal === "SIGTERM") resolve(143);
    else resolve(code ?? 0);
  });
});

process.exit(exitCode);
