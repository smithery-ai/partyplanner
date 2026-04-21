import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type DbApp = "backend" | "backend-node";

export type CliOptions = {
  app: DbApp;
  passthroughArgs: string[];
};

const scriptDir = dirname(fileURLToPath(import.meta.url));
export const packageDir = resolve(scriptDir, "..");
export const repoRoot = resolve(packageDir, "../..");

export function parseCliOptions(args: string[]): CliOptions {
  const passthroughArgs: string[] = [];
  let app = process.env.HYLO_DB_APP as DbApp | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--app") {
      app = args[index + 1] as DbApp | undefined;
      index += 1;
      continue;
    }
    if (arg.startsWith("--app=")) {
      app = arg.slice("--app=".length) as DbApp;
      continue;
    }
    passthroughArgs.push(arg);
  }

  if (app !== "backend" && app !== "backend-node") {
    throw new Error(
      "Set HYLO_DB_APP to backend or backend-node, or pass --app <name>",
    );
  }

  return { app, passthroughArgs };
}

export function connectionUrl(): string | undefined {
  return process.env.POSTGRES_URL ?? process.env.DATABASE_URL;
}

export function defaultPgliteDataDir(app: DbApp): string {
  const appDir = join(repoRoot, "apps", app);
  const envValue =
    app === "backend-node"
      ? process.env.HYLO_BACKEND_NODE_DATA_DIR
      : process.env.HYLO_BACKEND_PGLITE_DATA_DIR;

  if (envValue) {
    return isAbsolute(envValue) ? envValue : resolve(appDir, envValue);
  }

  if (app === "backend-node") {
    return join(appDir, ".hylo-backend-node");
  }

  return join(appDir, ".hylo-backend-pglite");
}

export async function findFreePort(host = "127.0.0.1"): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolveListen());
  });

  const address = server.address();
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });

  if (!address || typeof address === "string") {
    throw new Error("Unable to allocate a local TCP port");
  }

  return address.port;
}

export function packageManagerCommand(): { command: string; args: string[] } {
  if (existsSync(join(repoRoot, "pnpm-lock.yaml"))) {
    return { command: "pnpm", args: ["exec"] };
  }

  return { command: "npx", args: [] };
}
