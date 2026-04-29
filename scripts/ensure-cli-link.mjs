#!/usr/bin/env node
import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliDir = resolve(repoRoot, "packages/cli");
const cliEntry = resolve(cliDir, "dist/index.js");

console.log("Building and linking @hylo/cli globally...");
execSync("pnpm --filter @hylo/cli build", {
  cwd: repoRoot,
  stdio: "inherit",
});

if (!existsSync(cliEntry)) {
  console.error(`Expected ${cliEntry} after build. Aborting link.`);
  process.exit(1);
}

if (isAlreadyLinked()) {
  console.log("@hylo/cli is already linked globally — skipping pnpm link.");
} else {
  execSync("pnpm link --global", { cwd: cliDir, stdio: "inherit" });
}

function isAlreadyLinked() {
  try {
    const output = execFileSync("pnpm", ["root", "-g"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!output) return false;
    return existsSync(resolve(output, "@hylo/cli"));
  } catch {
    return false;
  }
}
