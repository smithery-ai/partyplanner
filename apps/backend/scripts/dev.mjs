import { spawn } from "node:child_process";
import { createServer } from "node:net";

const args = [
  "dev",
  "--ip",
  "127.0.0.1",
  "--port",
  process.env.PORT ?? "8788",
  "--inspector-ip",
  "127.0.0.1",
  "--inspector-port",
  process.env.WRANGLER_INSPECTOR_PORT ?? String(await freePort()),
];

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
