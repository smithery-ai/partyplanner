import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
export const packageDir = resolve(scriptDir, "..");

export function connectionUrl(): string | undefined {
  return process.env.POSTGRES_URL ?? process.env.DATABASE_URL;
}

export function requireConnectionUrl(): string {
  const url = connectionUrl();
  if (!url) {
    throw new Error("POSTGRES_URL or DATABASE_URL is required");
  }
  return url;
}
