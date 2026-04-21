import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
export const packageDir = resolve(scriptDir, "..");
export const repoRoot = resolve(packageDir, "../..");
export const backendDir = join(repoRoot, "apps", "backend");

export type BackendHandle = {
  url: string;
  stop(): Promise<void>;
};

export function parseUrlOption(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--url") return args[index + 1];
    if (arg.startsWith("--url=")) return arg.slice("--url=".length);
  }
  return undefined;
}

export function configuredBackendUrl(args: string[]): string | undefined {
  return (
    parseUrlOption(args) ??
    process.env.HYLO_CLOUDFLARE_DB_URL ??
    process.env.HYLO_BACKEND_URL
  );
}

export async function backendForCommand(
  args: string[],
): Promise<BackendHandle> {
  const configured = configuredBackendUrl(args);
  if (configured) {
    await waitForHealth(configured);
    return { url: configured, stop: async () => {} };
  }

  const defaultUrl = "http://127.0.0.1:8788";
  if (await isHealthy(defaultUrl)) {
    return { url: defaultUrl, stop: async () => {} };
  }

  const port = await findFreePort();
  const child = spawn(
    "pnpm",
    [
      "--filter",
      "backend",
      "exec",
      "wrangler",
      "dev",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      cwd: repoRoot,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        NODE_ENV: process.env.NODE_ENV ?? "development",
      },
    },
  );
  const output: string[] = [];
  collectOutput(child, output);

  const url = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(url);
  } catch (error) {
    await stopChild(child);
    const details = output.slice(-40).join("");
    throw new Error(`${String(error)}\n\nWrangler output:\n${details}`);
  }

  return {
    url,
    stop: () => stopChild(child),
  };
}

export async function waitForHealth(url: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${trimSlash(url)}/health`);
      if (response.ok) return;
      lastError = new Error(`Health check returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(`Backend at ${url} did not become healthy: ${lastError}`);
}

export async function findCloudflareSqliteFile(): Promise<string | undefined> {
  const stateDir = join(backendDir, ".wrangler", "state");
  const files = listFiles(stateDir).filter(isSqlitePath);
  if (files.length === 0) return undefined;
  files.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  return files[0];
}

export async function findFreePort(host = "127.0.0.1"): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolveListen());
  });

  const address = server.address();
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });

  if (!address || typeof address === "string") {
    throw new Error("Unable to allocate a local TCP port");
  }
  return address.port;
}

function collectOutput(child: ChildProcess, output: string[]): void {
  child.stdout?.on("data", (chunk) => output.push(String(chunk)));
  child.stderr?.on("data", (chunk) => output.push(String(chunk)));
}

async function isHealthy(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${trimSlash(url)}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveStop) => {
    const timeout = setTimeout(() => {
      killChild(child, "SIGKILL");
      resolveStop();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolveStop();
    });
    killChild(child, "SIGTERM");
  });
}

function killChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) files.push(...listFiles(path));
    else if (stat.isFile()) files.push(path);
  }
  return files;
}

function isSqlitePath(path: string): boolean {
  const ext = extname(path);
  if (ext !== ".sqlite" && ext !== ".sqlite3" && ext !== ".db") return false;
  if (!path.includes(`${join("v3", "do")}${pathSeparator()}`)) return false;
  return !path.endsWith(`${pathSeparator()}metadata.sqlite`);
}

function pathSeparator(): string {
  return process.platform === "win32" ? "\\" : "/";
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
