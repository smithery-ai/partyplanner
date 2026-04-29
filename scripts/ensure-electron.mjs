#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const desktopDir = path.join(rootDir, "apps", "desktop");
const requireFromDesktop = createRequire(path.join(desktopDir, "package.json"));

let electronDir;

try {
  electronDir = path.dirname(
    requireFromDesktop.resolve("electron/package.json"),
  );
} catch {
  console.error("Electron is not installed. Run pnpm install first.");
  process.exit(1);
}

if (isElectronInstalled()) {
  process.exit(0);
}

console.log("Electron binary is missing; rebuilding electron...");

const rebuild = spawnSync(
  "pnpm",
  ["--filter", "desktop", "rebuild", "electron"],
  {
    cwd: rootDir,
    stdio: "inherit",
    env: process.env,
  },
);

if (rebuild.status !== 0) {
  process.exit(rebuild.status ?? 1);
}

if (!isElectronInstalled()) {
  console.error(
    "Electron rebuild completed, but the Electron binary is still missing.",
  );
  process.exit(1);
}

function isElectronInstalled() {
  const pathFile = path.join(electronDir, "path.txt");

  if (!existsSync(pathFile)) {
    return false;
  }

  const executablePath = readFileSync(pathFile, "utf8").trim();

  return existsSync(path.join(electronDir, "dist", executablePath));
}
