#!/usr/bin/env node
import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";

const host = "127.0.0.1";
const tunnelInfoPath = ".hylo/dev-tunnel.json";
const portlessCaPath = "/tmp/portless/ca.pem";
const portSpecs = [
  ["HYLO_BACKEND_PORT", 8787],
  ["HYLO_BACKEND_INSPECTOR_PORT", 9230],
  ["HYLO_CLOUDFLARE_WORKER_INSPECTOR_PORT", 9231],
];

const reserved = new Set();
const env = { ...process.env };
const args = new Set(process.argv.slice(2).filter((arg) => arg !== "--"));
const enableBackendTunnel =
  args.has("--tunnel") || env.HYLO_BACKEND_TUNNEL === "1";

if (!env.NODE_EXTRA_CA_CERTS && existsSync(portlessCaPath)) {
  env.NODE_EXTRA_CA_CERTS = portlessCaPath;
}
env.NODE_TLS_REJECT_UNAUTHORIZED ??= "0";

for (const [name, fallback] of portSpecs) {
  env[name] = String(await resolvePort(name, fallback));
}
env.HYLO_BACKEND_URL ??= `http://${host}:${env.HYLO_BACKEND_PORT}`;

execSync(`portless alias api-worker.hylo ${env.HYLO_BACKEND_PORT}`, {
  stdio: "ignore",
});

let backendTunnel;
if (enableBackendTunnel) {
  console.log("Starting Cloudflare tunnel for the local backend...");
  backendTunnel = await startBackendTunnel(env.HYLO_BACKEND_PORT);
  env.HYLO_BACKEND_TUNNEL_URL = backendTunnel.url;
  env.HYLO_BACKEND_PUBLIC_URL = backendTunnel.url;
  writeTunnelInfo(backendTunnel.url, env.HYLO_BACKEND_PORT);
  console.log(`  public backend: ${backendTunnel.url}`);
  console.log(`  public webhooks: ${backendTunnel.url}/webhooks`);
  console.log(`  tunnel info: ${tunnelInfoPath}`);
}

console.log("Preparing local workflow package builds...");
execSync("pnpm --filter @workflow/integrations-slack build", {
  env,
  stdio: "inherit",
});

console.log("Applying local backend database migrations...");
execSync("pnpm --filter backend-cloudflare db:migrate:dev", {
  env,
  stdio: "inherit",
});

console.log("pnpm dev using local ports:");
console.log("  client: https://hylo-client.localhost");
console.log(
  `  backend-node: https://api-worker.hylo.localhost (port ${env.HYLO_BACKEND_PORT})`,
);
if (env.HYLO_BACKEND_TUNNEL_URL) {
  console.log(`  backend tunnel: ${env.HYLO_BACKEND_TUNNEL_URL}`);
}
console.log(
  "  workflow-cloudflare-worker-example: https://workflow-cloudflare-worker-example.localhost",
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
    "dev:info",
    "--filter=backend-node",
    "--filter=workflow-cloudflare-worker-example",
    "--filter=client",
    "--filter=//",
  ],
  {
    env,
    stdio: "inherit",
  },
);

child.on("exit", (code, signal) => {
  stopBackendTunnel(backendTunnel);
  if (signal) {
    process.exit(1);
    return;
  }
  process.exit(code ?? 0);
});

child.on("error", (error) => {
  stopBackendTunnel(backendTunnel);
  console.error(`Failed to start pnpm dev: ${error.message}`);
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopBackendTunnel(backendTunnel);
    child.kill(signal);
  });
}

function startBackendTunnel(port) {
  return new Promise((resolve, reject) => {
    const target = `http://${host}:${port}`;
    const child = spawn(
      "cloudflared",
      ["--no-autoupdate", "tunnel", "--url", target],
      {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(
        new Error(
          "Timed out waiting for cloudflared to report a public tunnel URL.",
        ),
      );
    }, 30_000);

    const handleOutput = (chunk) => {
      const text = chunk.toString();
      process.stderr.write(text);
      const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (!match || settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ process: child, url: match[0] });
    };

    child.stdout.on("data", handleOutput);
    child.stderr.on("data", handleOutput);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(
        new Error(
          `Failed to start cloudflared. Install it or run without --tunnel. ${error.message}`,
        ),
      );
    });
    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(
        new Error(
          `cloudflared exited before a tunnel URL was available (${signal ?? code}).`,
        ),
      );
    });
  });
}

function stopBackendTunnel(tunnel) {
  if (!tunnel || tunnel.process.killed) return;
  tunnel.process.kill("SIGTERM");
}

function writeTunnelInfo(url, backendPort) {
  mkdirSync(".hylo", { recursive: true });
  writeFileSync(
    tunnelInfoPath,
    `${JSON.stringify(
      {
        backendUrl: url,
        webhooksUrl: `${url.replace(/\/+$/, "")}/webhooks`,
        localBackendUrl: `http://${host}:${backendPort}`,
        writtenAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
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
