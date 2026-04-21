import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";

const backendUrl =
  process.env.HYLO_BACKEND_URL ??
  derivePortlessServiceUrl(
    process.env.PORTLESS_URL,
    "cloudflare-worker.hylo",
    "api.hylo",
  );

const args = [
  "dev",
  "--ip",
  "127.0.0.1",
  "--port",
  process.env.PORT ?? "8789",
  "--inspector-ip",
  "127.0.0.1",
  "--inspector-port",
  process.env.WRANGLER_INSPECTOR_PORT ?? String(await freePort()),
];

const envFiles = [".dev.vars", ".env"].filter((path) => existsSync(path));
for (const envFile of envFiles) {
  args.push("--env-file", envFile);
}

addWorkerVar("HYLO_BACKEND_URL", backendUrl);
if (envFiles.length === 0) {
  addWorkerVar(
    "INCIDENT_PUBLISHER_TOKEN",
    process.env.INCIDENT_PUBLISHER_TOKEN,
  );
}

const child = spawn("wrangler", args, {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

function derivePortlessServiceUrl(sourceUrl, sourceName, targetName) {
  if (!sourceUrl) return undefined;

  try {
    const url = new URL(sourceUrl);
    const sourcePrefix = `${sourceName}.`;
    const sourceMarker = `.${sourceName}.`;

    if (url.hostname.startsWith(sourcePrefix)) {
      url.hostname = `${targetName}.${url.hostname.slice(sourcePrefix.length)}`;
      return url.origin;
    }

    const markerIndex = url.hostname.indexOf(sourceMarker);
    if (markerIndex === -1) return undefined;

    const prefix = url.hostname.slice(0, markerIndex);
    const suffix = url.hostname.slice(markerIndex + sourceMarker.length);
    url.hostname = `${prefix}.${targetName}.${suffix}`;
    return url.origin;
  } catch {
    return undefined;
  }
}

function addWorkerVar(name, value) {
  if (value) args.push("--var", `${name}:${value}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (!address || typeof address === "string") {
          reject(new Error("Unable to allocate a Wrangler inspector port."));
          return;
        }
        resolve(address.port);
      });
    });
  });
}
