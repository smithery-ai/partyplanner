import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const hyloScriptPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "hylo.mjs",
);
export const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

export function validateHttpUrl(value, label) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("URL must use http: or https:");
    }
    return url.toString().replace(/\/$/, "");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    die(`invalid ${label} "${value}": ${detail}`);
  }
}

export function isHttpUrl(value) {
  if (!value) return false;
  return /^https?:\/\//i.test(value.trim());
}

export function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function packagePath(packageDir) {
  return relative(repoRoot, packageDir);
}

export function formatPackagePath(packageDir) {
  return `./${packagePath(packageDir)}`;
}

export function packageJsonAt(packageDir) {
  const packageJsonPath = join(packageDir, "package.json");
  if (!existsSync(packageJsonPath)) {
    die(`${packageJsonPath} does not exist`);
  }
  return JSON.parse(readFileSync(packageJsonPath, "utf8"));
}

export function die(message) {
  console.error(`hylo: ${message}`);
  process.exit(1);
}
