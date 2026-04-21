import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function localBackendUrl(): string {
  const packageJson = JSON.parse(
    readFileSync(resolve(appRoot, "package.json"), "utf8"),
  );
  const value = packageJson.hylo?.backend?.url;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("backend-node package.json must set hylo.backend.url");
  }
  return new URL(value).toString().replace(/\/$/, "");
}

export function localBackendPort(): number {
  const url = new URL(localBackendUrl());
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}
