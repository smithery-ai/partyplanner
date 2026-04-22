import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function portlessBinPath() {
  return join(
    dirname(fileURLToPath(import.meta.resolve("portless"))),
    "cli.js",
  );
}

export function devServiceNameFromUrl(value) {
  const normalized = value.trim();
  if (!normalized) return undefined;

  try {
    return new URL(normalized).hostname.replace(/\.localhost$/, "");
  } catch {
    return normalized.replace(/^https?:\/\//, "").replace(/\.localhost$/, "");
  }
}
