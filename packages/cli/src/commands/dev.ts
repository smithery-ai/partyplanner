import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config.js";
import { findFreePort, spawnBackend } from "../dev-backend.js";
import { log } from "../log.js";
import { generatedWranglerPath, hyloDir } from "../paths.js";
import { runWrangler } from "../runner.js";
import { buildWranglerConfig } from "../wrangler-config.js";

export async function dev(argv: string[]): Promise<number> {
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

  const wranglerArgs = ["dev", "-c", wranglerPath];
  let stopBackend: (() => Promise<void>) | undefined;
  const reservedPorts = new Set<number>();

  if (config.backend && !config.vars?.HYLO_BACKEND_URL) {
    const backend = await spawnBackend(config.backend, cwd);
    stopBackend = backend.stop;
    const backendPort = Number(new URL(backend.url).port);
    if (Number.isFinite(backendPort)) reservedPorts.add(backendPort);
    wranglerArgs.push("--var", `HYLO_BACKEND_URL:${backend.url}`);
  } else if (config.vars?.HYLO_BACKEND_URL) {
    log.step(
      `Using HYLO_BACKEND_URL from hylo.config.ts (${config.vars.HYLO_BACKEND_URL})`,
    );
  }

  if (!argv.includes("--port") && !argv.includes("-p")) {
    const wranglerPort = await findFreePort(8787, reservedPorts);
    wranglerArgs.push("--ip", "127.0.0.1", "--port", String(wranglerPort));
  }

  wranglerArgs.push(...argv);

  log.step("Starting wrangler dev");
  const { child, exitCode } = runWrangler(wranglerArgs, cwd);

  const forward = (sig: NodeJS.Signals) => {
    if (!child.killed) child.kill(sig);
  };
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);

  try {
    return await exitCode;
  } finally {
    process.off("SIGINT", forward);
    process.off("SIGTERM", forward);
    if (stopBackend) {
      try {
        await stopBackend();
      } catch {
        /* best-effort */
      }
    }
  }
}
