import { createServer } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
export const packageDir = resolve(scriptDir, "..");
export const repoRoot = resolve(packageDir, "../..");

export function connectionUrl(): string | undefined {
  return process.env.POSTGRES_URL ?? process.env.DATABASE_URL;
}

export function defaultPgliteDataDir(): string {
  const appDir = join(repoRoot, "apps", "backend-node");
  const envValue = process.env.HYLO_BACKEND_NODE_DATA_DIR;

  if (envValue) {
    return isAbsolute(envValue) ? envValue : resolve(appDir, envValue);
  }

  return join(appDir, ".hylo-backend-node");
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
