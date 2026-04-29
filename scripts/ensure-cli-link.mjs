#!/usr/bin/env node
import { execFileSync, execSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
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

if (isLinkedToCurrentWorkspace()) {
  console.log("@hylo/cli is already linked globally — skipping pnpm link.");
} else {
  execSync("pnpm link --global", { cwd: cliDir, stdio: "inherit" });
}

function isLinkedToCurrentWorkspace() {
  try {
    const output = execFileSync("pnpm", ["root", "-g"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!output) return false;
    const linkedCliDir = resolve(output, "@hylo/cli");
    return (
      existsSync(linkedCliDir) &&
      realpathSync(linkedCliDir) === realpathSync(cliDir)
    );
  } catch {
    return false;
  }
}
