import { spawn } from "node:child_process";
import { join } from "node:path";
import {
  backendForCommand,
  findCloudflareSqliteFile,
  packageDir,
} from "./db-common";

let sqliteFile = await findCloudflareSqliteFile();

if (!sqliteFile) {
  const backend = await backendForCommand(process.argv.slice(2));
  try {
    sqliteFile = await findCloudflareSqliteFile();
  } finally {
    await backend.stop();
  }
}

if (!sqliteFile) {
  throw new Error(
    "No local Cloudflare Durable Object SQLite file was found under apps/backend/.wrangler/state. Run pnpm --filter backend dev once, then try db:studio again.",
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
