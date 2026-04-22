import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config.js";
import { log } from "../log.js";
import { generatedWranglerPath, hyloDir } from "../paths.js";
import { runWrangler } from "../runner.js";
import { buildWranglerConfig } from "../wrangler-config.js";

export async function deploy(argv: string[]): Promise<number> {
  const cwd = process.cwd();
  const { config, configPath } = await loadConfig(cwd);
  log.step(`Loaded ${path.relative(cwd, configPath)}`);

  const outputDir = hyloDir(cwd);
  await mkdir(outputDir, { recursive: true });

  const wrangler = buildWranglerConfig({
    hyloConfig: config,
    projectRoot: cwd,
    outputDir,
  });
  const wranglerPath = generatedWranglerPath(cwd);
  await writeFile(wranglerPath, `${JSON.stringify(wrangler, null, 2)}\n`);
  log.step(`Wrote ${path.relative(cwd, wranglerPath)}`);

  const deployArgs = ["deploy", "-c", wranglerPath];
  if (config.dispatchNamespace) {
    deployArgs.push("--dispatch-namespace", config.dispatchNamespace);
    log.step(
      `Deploying to Workers for Platforms namespace '${config.dispatchNamespace}'`,
    );
  } else {
    log.step("Deploying to Cloudflare Workers");
  }
  deployArgs.push(...argv);
  const { exitCode } = runWrangler(deployArgs, cwd);
  return exitCode;
}
