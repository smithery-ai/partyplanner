import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { spawnAndExit } from "./process.mjs";
import { die, repoRoot } from "./shared.mjs";

const require = createRequire(import.meta.url);

export function runWorkflowCliCommand(args) {
  const packageDir = join(repoRoot, "packages", "cli");
  const builtCli = join(packageDir, "dist", "cli.js");
  const sourceCli = join(packageDir, "src", "cli.ts");

  if (existsSync(builtCli)) {
    spawnAndExit([process.execPath, builtCli, ...args], process.env);
    return;
  }

  if (!existsSync(sourceCli)) {
    die("packages/cli is missing. Cannot forward to the workflow CLI.");
  }

  let tsxCli;
  try {
    tsxCli = require.resolve("tsx/cli");
  } catch {
    die("packages/cli is not built and tsx is not installed.");
  }

  spawnAndExit([process.execPath, tsxCli, sourceCli, ...args], process.env);
}
