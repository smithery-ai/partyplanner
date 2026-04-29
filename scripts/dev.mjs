#!/usr/bin/env node
import { execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { resolve } from "node:path";

const host = "127.0.0.1";
const portlessCaPath = "/tmp/portless/ca.pem";
const flamecastRoot = process.env.FLAMECAST_LOG_DIR
  ? resolve(process.env.FLAMECAST_LOG_DIR)
  : resolve(homedir(), ".flamecast");
const localWorkerDir = resolve(flamecastRoot, "worker");
const portSpecs = [
  ["HYLO_BACKEND_PORT", 8787],
  ["HYLO_BACKEND_INSPECTOR_PORT", 9230],
  ["HYLO_CLOUDFLARE_WORKER_INSPECTOR_PORT", 9231],
];

const reserved = new Set();
const env = { ...process.env };

if (!env.NODE_EXTRA_CA_CERTS && existsSync(portlessCaPath)) {
  env.NODE_EXTRA_CA_CERTS = portlessCaPath;
}
env.NODE_TLS_REJECT_UNAUTHORIZED ??= "0";
env.PORTLESS_HTTPS ??= "1";
env.PORTLESS_PORT = "443";

// Defensive cleanup: a previous pnpm dev that was killed mid-flight (Ctrl-C
// during a build, IDE crash, etc.) can leave wrangler/inspector children
// holding 8787/9230/9231/8788. resolvePort() picks a different port for the
// parent worker, but wrangler's own --inspector-port is fixed by the time we
// spawn it, and the inspector EADDRINUSE crashes the whole dev session.
// Kill anything still listening on the canonical ports before booting.
killStaleListeners([8787, 8788, 9230, 9231]);

for (const [name, fallback] of portSpecs) {
  env[name] = String(await resolvePort(name, fallback));
}

ensurePortlessHttpsProxy(env);

execSync(`portless alias api-worker.hylo ${env.HYLO_BACKEND_PORT}`, {
  env,
  stdio: "ignore",
});

execSync("node scripts/ensure-cli-link.mjs", { env, stdio: "inherit" });

console.log("Applying local backend database migrations...");
execSync("pnpm --filter backend-cloudflare db:migrate:dev", {
  env,
  stdio: "inherit",
});

ensureLocalWorker();

console.log("pnpm dev using local ports:");
console.log("  client: https://hylo-client.localhost");
console.log("  local-api: https://local-api.localhost");
console.log(
  `  backend-cloudflare: https://api-worker.hylo.localhost (port ${env.HYLO_BACKEND_PORT})`,
);
console.log(
  "  ~/.flamecast/worker: https://workflow-cloudflare-worker-example.localhost",
);
console.log(`  backend inspector: ${env.HYLO_BACKEND_INSPECTOR_PORT}`);
console.log(
  `  workflow inspector: ${env.HYLO_CLOUDFLARE_WORKER_INSPECTOR_PORT}`,
);

const children = [];

children.push(
  spawn(
    "pnpm",
    [
      "exec",
      "turbo",
      "run",
      "dev",
      "dev:info",
      "dev:worker",
      "--filter=backend-cloudflare",
      "--filter=client",
      "--filter=local-api",
      "--filter=//",
    ],
    {
      env,
      stdio: "inherit",
    },
  ),
);

let exiting = false;

for (const child of children) {
  child.on("exit", (code, signal) => {
    if (exiting) return;
    exiting = true;
    killChildren(signal ?? "SIGTERM");
    if (signal) {
      process.exit(1);
      return;
    }
    process.exit(code ?? 0);
  });

  child.on("error", (error) => {
    if (exiting) return;
    exiting = true;
    killChildren("SIGTERM");
    console.error(`Failed to start pnpm dev: ${error.message}`);
    process.exit(1);
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (exiting) return;
    exiting = true;
    killChildren(signal);
    process.exit(0);
  });
}

function killChildren(signal) {
  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }
}

function ensureLocalWorker() {
  const packageJsonPath = resolve(localWorkerDir, "package.json");
  if (existsSync(packageJsonPath)) return;

  console.log(`Initializing ${localWorkerDir} with hylo init...`);
  execSync("pnpm hylo init", {
    env,
    stdio: "inherit",
  });
}

async function resolvePort(name, fallback) {
  const raw = process.env[name]?.trim();
  const explicit = raw ? parsePort(name, raw) : undefined;

  if (explicit !== undefined) {
    if (reserved.has(explicit) || !(await canListen(explicit))) {
      throw new Error(`${name}=${explicit} is not available on ${host}.`);
    }
    reserved.add(explicit);
    return explicit;
  }

  for (let port = fallback; port < 65536; port += 1) {
    if (reserved.has(port)) continue;
    if (await canListen(port)) {
      reserved.add(port);
      return port;
    }
  }

  throw new Error(`No available local port found for ${name}.`);
}

function parsePort(name, value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be an integer from 1 to 65535.`);
  }
  return port;
}

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen({ host, port });
  });
}

function ensurePortlessHttpsProxy(env) {
  const currentPort = readCurrentPortlessProxyPort();
  if (currentPort !== undefined && currentPort !== 443) {
    console.log(
      `Restarting portless HTTPS proxy on port 443 (was ${currentPort})...`,
    );
    try {
      execSync(`portless proxy stop --port ${currentPort}`, {
        env,
        stdio: "inherit",
      });
    } catch (error) {
      console.error(`Failed to stop portless proxy on port ${currentPort}.`);
      process.exit(typeof error.status === "number" ? error.status : 1);
    }
  }

  try {
    execSync("portless proxy start --https --port 443", {
      env,
      stdio: "inherit",
    });
  } catch (error) {
    console.error("Failed to start the portless HTTPS proxy.");
    process.exit(typeof error.status === "number" ? error.status : 1);
  }
}

function readCurrentPortlessProxyPort() {
  try {
    const output = execSync("portless get hylo-client", {
      env,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
    }).trim();
    if (!output) return undefined;
    const url = new URL(output);
    return url.port ? parsePort("portless proxy port", url.port) : 443;
  } catch {
    return undefined;
  }
}

function killStaleListeners(ports) {
  for (const port of ports) {
    let pids = "";
    try {
      pids = execSync(`lsof -ti :${port}`, {
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
    } catch {
      // No process is listening — nothing to do.
      continue;
    }
    if (!pids) continue;
    const pidList = pids.split("\n").filter(Boolean);
    console.warn(
      `Cleaning up ${pidList.length} stale process(es) on :${port} (pid ${pidList.join(", ")}).`,
    );
    try {
      execSync(`kill -9 ${pidList.join(" ")}`, { stdio: "ignore" });
    } catch {
      // Process may have already exited; ignore.
    }
  }
}
