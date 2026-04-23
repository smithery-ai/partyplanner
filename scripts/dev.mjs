#!/usr/bin/env node
import { spawn } from "node:child_process";
import net from "node:net";

const host = "127.0.0.1";
const portSpecs = [
  ["HYLO_BACKEND_PORT", 8787],
  ["HYLO_CLOUDFLARE_WORKER_PORT", 8788],
  ["HYLO_BACKEND_INSPECTOR_PORT", 9230],
  ["HYLO_CLOUDFLARE_WORKER_INSPECTOR_PORT", 9231],
];

const reserved = new Set();
const env = { ...process.env };

for (const [name, fallback] of portSpecs) {
  env[name] = String(await resolvePort(name, fallback));
}

console.log("pnpm dev using local ports:");
console.log(`  backend-cloudflare: http://${host}:${env.HYLO_BACKEND_PORT}`);
console.log(
  `  workflow-cloudflare-worker-example: http://${host}:${env.HYLO_CLOUDFLARE_WORKER_PORT}`,
);
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
    "--filter=backend-cloudflare",
    "--filter=workflow-cloudflare-worker-example",
    "--filter=client",
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
