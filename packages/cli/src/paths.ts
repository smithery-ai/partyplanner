import path from "node:path";
import { fileURLToPath } from "node:url";

export const HYLO_DIR = ".hylo";
export const GENERATED_WRANGLER_FILE = "wrangler.json";

export function hyloDir(projectRoot: string): string {
  return path.join(projectRoot, HYLO_DIR);
}

export function generatedWranglerPath(projectRoot: string): string {
  return path.join(hyloDir(projectRoot), GENERATED_WRANGLER_FILE);
}

export function packageRoot(): string {
  // This file is emitted at dist/paths.js inside the package.
  return path.resolve(fileURLToPath(import.meta.url), "..", "..");
}

export function templatesDir(): string {
  return path.join(packageRoot(), "templates");
}
