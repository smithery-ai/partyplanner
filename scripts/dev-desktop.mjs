#!/usr/bin/env node
import { execSync, spawn } from "node:child_process";

const env = { ...process.env };
const backendUrl = (
  env.VITE_HYLO_BACKEND_URL ??
  env.HYLO_BACKEND_URL ??
  "https://backend.flamecast.dev"
).replace(/\/+$/, "");

execSync("node scripts/ensure-cli-link.mjs", { env, stdio: "inherit" });

console.log("pnpm dev:desktop using:");
console.log(`  backend: ${backendUrl}`);
console.log("  WorkOS: discovered from the backend auth client config");
console.log("  local-api: https://local-api.localhost");
console.log("  desktop: launches Electron with the selected backend");

const filters = ["--filter=local-api", "--filter=desktop"];
if (env.VITE_HYLO_WORKFLOW || env.HYLO_WORKFLOW) {
  filters.unshift("--filter=workflow-cloudflare-worker-example");
  console.log(
    "  workflow-cloudflare-worker-example: https://workflow-cloudflare-worker-example.localhost",
  );
}

const child = spawn("pnpm", ["exec", "turbo", "run", "dev", ...filters], {
  env,
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
  console.error(`Failed to start pnpm dev: ${error.message}`);
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    child.kill(signal);
  });
}
