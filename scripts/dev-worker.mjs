#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const APP_NAME = "dev-worker";
const SCRATCH_DIR = path.join(REPO_ROOT, ".scratch");
const APP_DIR = path.join(SCRATCH_DIR, APP_NAME);
const CLI_PKG = path.join(REPO_ROOT, "packages/cli");
const CLI_BIN = path.join(CLI_PKG, "dist/cli.js");
const CLIENT_URL = "https://hylo-eight.vercel.app";

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd ?? REPO_ROOT,
      stdio: "inherit",
      env: process.env,
      shell: process.platform === "win32",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) return reject(new Error(`${cmd} killed (${signal})`));
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} exited with ${code}`));
    });
  });
}

function openBrowser(url) {
  const opener =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  spawn(opener, [url], {
    stdio: "ignore",
    shell: process.platform === "win32",
    detached: true,
  }).unref();
}

async function main() {
  if (!existsSync(CLI_BIN)) {
    console.log("[dev:worker] Building @workflow/cli");
    await run("pnpm", ["-C", CLI_PKG, "build"]);
  }

  if (existsSync(APP_DIR)) {
    console.log(`[dev:worker] Removing ${path.relative(REPO_ROOT, APP_DIR)}`);
    await rm(APP_DIR, { recursive: true, force: true });
  }
  await mkdir(SCRATCH_DIR, { recursive: true });

  console.log(`[dev:worker] Scaffolding ${APP_NAME}`);
  await run("node", [CLI_BIN, "init", APP_NAME], { cwd: SCRATCH_DIR });

  console.log("[dev:worker] Injecting backend-node into hylo.config.ts");
  await writeFile(
    path.join(APP_DIR, "hylo.config.ts"),
    `import { defineConfig } from "@workflow/cli";

export default defineConfig({
  name: "${APP_NAME}",
  main: "src/index.ts",
  compatibilityDate: "2026-04-19",
  compatibilityFlags: ["global_fetch_strictly_public"],
  backend: {
    command: ["pnpm", "exec", "tsx", "src/index.ts"],
    cwd: "../../apps/backend-node",
    port: 8787,
  },
});
`,
  );

  console.log("[dev:worker] pnpm install");
  await run("pnpm", ["install"]);

  console.log("[dev:worker] Building workspace packages");
  await run("pnpm", [
    "turbo",
    "run",
    "build",
    "--filter=@workflow/cli...",
    "--filter=backend-node...",
  ]);

  console.log(
    `[dev:worker] Starting workflow dev in ${path.relative(REPO_ROOT, APP_DIR)}`,
  );
  const child = spawn("node", [CLI_BIN, "dev"], {
    cwd: APP_DIR,
    stdio: ["inherit", "pipe", "pipe"],
    env: process.env,
  });

  let opened = false;
  // Match wrangler's "Ready on http://..." line specifically, so we don't
  // accidentally capture the backend-node URL that also appears in stdout.
  const wranglerReadyRe =
    /Ready on (https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+)/;

  const watch = (stream, out) => {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      out.write(chunk);
      if (opened) return;
      const match = chunk.match(wranglerReadyRe);
      if (match) {
        opened = true;
        const target = `${CLIENT_URL}?worker=${match[1]}`;
        console.log(`\n[dev:worker] Opening ${target}\n`);
        openBrowser(target);
      }
    });
  };
  watch(child.stdout, process.stdout);
  watch(child.stderr, process.stderr);

  const shutdown = (sig) => {
    if (!child.killed) child.kill(sig);
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  child.on("exit", (code) => process.exit(code ?? 0));
}

main().catch((err) => {
  console.error("[dev:worker]", err);
  process.exit(1);
});
