import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
export const packageDir = resolve(scriptDir, "..");
export const repoRoot = resolve(packageDir, "../..");
export const backendDir = join(repoRoot, "apps", "backend-cloudflare");

export function findLocalD1SqliteFile(): string | undefined {
  const stateDir = join(backendDir, ".wrangler", "state");
  const files = listFiles(stateDir).filter(isD1SqlitePath);
  if (files.length === 0) return undefined;
  files.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  return files[0];
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) files.push(...listFiles(path));
    else if (stat.isFile()) files.push(path);
  }
  return files;
}

function isD1SqlitePath(path: string): boolean {
  const ext = extname(path);
  if (ext !== ".sqlite" && ext !== ".sqlite3" && ext !== ".db") return false;
  return path.includes(`${pathSeparator()}d1${pathSeparator()}`);
}

function pathSeparator(): string {
  return process.platform === "win32" ? "\\" : "/";
}
