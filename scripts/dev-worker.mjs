#!/usr/bin/env node
import { execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const flamecastRoot = process.env.FLAMECAST_LOG_DIR
  ? resolve(process.env.FLAMECAST_LOG_DIR)
  : resolve(homedir(), ".flamecast");
const localWorkerDir = resolve(flamecastRoot, "worker");

ensureLocalWorker();

const child = spawn("pnpm", ["hylo", "dev", localWorkerDir], {
  env: process.env,
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.exit(1);
    return;
  }
  process.exit(code ?? 0);
});

child.on("error", (error) => {
  console.error(`Failed to start local worker dev server: ${error.message}`);
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    child.kill(signal);
  });
}

function ensureLocalWorker() {
  const packageJsonPath = resolve(localWorkerDir, "package.json");
  if (existsSync(packageJsonPath)) return;

  console.log(`Initializing ${localWorkerDir} with hylo init...`);
  execSync("pnpm hylo init", {
    env: process.env,
    stdio: "inherit",
  });
}
