import { spawn } from "node:child_process";
import { join } from "node:path";
import { packageDir, requireConnectionUrl } from "./db-common";

const passthroughArgs = process.argv.slice(2).filter((arg) => arg !== "--");
const url = requireConnectionUrl();

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
    },
  },
);

process.on("SIGINT", () => {
  child.kill("SIGINT");
});

process.on("SIGTERM", () => {
  child.kill("SIGTERM");
});

child.on("exit", (code, signal) => {
  if (signal === "SIGINT") process.exit(130);
  else if (signal === "SIGTERM") process.exit(143);
  else process.exit(code ?? 0);
});
