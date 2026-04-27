#!/usr/bin/env node
import { execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";

const host = "127.0.0.1";
const portlessCaPath = "/tmp/portless/ca.pem";
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

for (const [name, fallback] of portSpecs) {
  env[name] = String(await resolvePort(name, fallback));
}

env.VITE_HYLO_BACKEND_URL ??= "https://api-worker.hylo.localhost";

ensurePortlessHttpsProxy(env);

execSync(`portless alias api-worker.hylo ${env.HYLO_BACKEND_PORT}`, {
  env,
  stdio: "ignore",
});

console.log("Applying local backend database migrations...");
execSync("pnpm --filter backend-cloudflare db:migrate:dev", {
  env,
  stdio: "inherit",
});

console.log("pnpm dev:desktop using local ports:");
console.log(`  backend-node: ${env.VITE_HYLO_BACKEND_URL}`);
console.log(
  "  workflow-cloudflare-worker-example: https://workflow-cloudflare-worker-example.localhost",
);
console.log("  desktop: launches Electron with the local backend");
console.log(`  backend inspector: ${env.HYLO_BACKEND_INSPECTOR_PORT}`);
console.log(
  `  workflow inspector: ${env.HYLO_CLOUDFLARE_WORKER_INSPECTOR_PORT}`,
);

const child = spawn(
  "pnpm",
  [
    "exec",
    "turbo",
    "run",
    "dev",
    "--filter=backend-node",
    "--filter=workflow-cloudflare-worker-example",
    "--filter=desktop",
  ],
  {
    env,
    stdio: "inherit",
  },
);

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
  try {
    execSync("portless proxy start --https", {
      env,
      stdio: "pipe",
      encoding: "utf-8",
    });
  } catch (error) {
    const details = [
      typeof error.stdout === "string" ? error.stdout.trim() : "",
      typeof error.stderr === "string" ? error.stderr.trim() : "",
    ]
      .filter(Boolean)
      .join("\n");
    if (details) {
      console.error(details);
    } else {
      console.error("Failed to start the portless HTTPS proxy.");
    }
    process.exit(typeof error.status === "number" ? error.status : 1);
  }
}
