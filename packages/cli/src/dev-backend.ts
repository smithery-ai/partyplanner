import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import type { BackendSpawnConfig } from "./config.js";
import { log } from "./log.js";

export interface RunningBackend {
  url: string;
  stop(): Promise<void>;
}

const DEFAULT_PORT = 8787;
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 150;

export async function spawnBackend(
  backend: BackendSpawnConfig,
  projectRoot: string,
): Promise<RunningBackend> {
  const [cmd, ...args] = backend.command;
  if (!cmd) throw new Error("backend.command must not be empty");

  const port = await findFreePort(backend.port ?? DEFAULT_PORT);
  const cwd = path.resolve(projectRoot, backend.cwd ?? ".");

  log.step(`Spawning backend: ${backend.command.join(" ")} (port=${port})`);

  // detached=true puts the backend in its own process group, so we can kill
  // the whole tree (e.g. pnpm → tsx → node) by sending to -pid.
  const child = spawn(cmd, args, {
    cwd,
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      ...backend.env,
      PORT: String(port),
    },
    shell: process.platform === "win32",
    detached: process.platform !== "win32",
  });

  const earlyExit = new Promise<never>((_, reject) => {
    child.once("exit", (code, signal) => {
      reject(
        new Error(
          `Backend exited before becoming ready (code=${code}, signal=${signal})`,
        ),
      );
    });
    child.once("error", reject);
  });

  await Promise.race([waitForPort(port, READY_TIMEOUT_MS), earlyExit]);

  const url = `http://localhost:${port}`;
  log.success(`Backend ready at ${url}`);

  return {
    url,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.killed || child.exitCode !== null) return resolve();
        child.once("exit", () => resolve());
        try {
          if (process.platform !== "win32" && child.pid) {
            process.kill(-child.pid, "SIGTERM");
          } else {
            child.kill("SIGTERM");
          }
        } catch {
          resolve();
        }
      }),
  };
}

export async function findFreePort(
  start: number,
  avoid: Set<number> = new Set(),
): Promise<number> {
  for (let port = start; port < start + 100; port++) {
    if (avoid.has(port)) continue;
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port found in range ${start}-${start + 100}`);
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    // Bind to unspecified so we detect conflicts on IPv4 AND IPv6 bindings.
    server.listen(port);
  });
}

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probePort(port)) return;
    await sleep(READY_POLL_MS);
  }
  throw new Error(`Backend did not open port ${port} within ${timeoutMs}ms`);
}

function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
