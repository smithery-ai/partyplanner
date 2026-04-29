import { spawn, spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import net from "node:net";
import { resolve } from "node:path";
import { parseBuildArgs } from "../args.js";
import { resolveHyloBackendUrl } from "../config.js";
import { info } from "../log.js";
import { defaultProjectRoot, loadProject } from "../project.js";
import { envSecretWranglerVars } from "../secrets.js";
import { wranglerBin } from "../wrangler.js";
import { buildWorkerBundle } from "./build.js";

const DEFAULT_WORKER_PORT = "8788";
const DEFAULT_INSPECTOR_PORT = "9231";
const LOCAL_SECRET_VALUE = "local-dev-incident-publisher-token";

export async function runDev(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(
      [
        "Usage: hylo dev [dir] [--local]",
        "",
        "Builds and runs a Hylo Worker locally. Defaults to the current worker project or ~/.flamecast/worker.",
        "",
      ].join("\n"),
    );
    return 0;
  }

  const { options, rest } = parseBuildArgs(args);
  if (rest.length > 1) {
    throw new Error(`Unexpected argument for dev: ${rest[1]}`);
  }

  const projectRoot = rest[0]
    ? resolve(process.cwd(), rest[0])
    : await defaultProjectRoot(process.cwd());
  const backendUrl = resolveHyloBackendUrl({ local: options.local });
  const project = await loadProject(projectRoot);

  await ensureDependencies(project.root);
  await buildWorkerBundle(project, { ...options, backendUrl });

  const appUrl = `https://${project.workerName}.localhost`;
  const workerPort = await resolvePort("PORT", DEFAULT_WORKER_PORT);
  const inspectorPort = await resolvePort(
    "HYLO_CLOUDFLARE_WORKER_INSPECTOR_PORT",
    DEFAULT_INSPECTOR_PORT,
    new Set([workerPort]),
  );
  const envSecretVars = await envSecretWranglerVars(
    resolve(project.root, "src"),
  );
  const wranglerArgs = [
    "dev",
    ".hylo/build/src/index.ts",
    "--config",
    ".hylo/build/wrangler.toml",
    "--ip",
    "127.0.0.1",
    "--port",
    `\${PORT:-${workerPort}}`,
    "--inspector-port",
    inspectorPort,
    "--var",
    `INCIDENT_PUBLISHER_TOKEN:${process.env.INCIDENT_PUBLISHER_TOKEN ?? LOCAL_SECRET_VALUE}`,
    ...envSecretVars,
    "--var",
    `HYLO_APP_URL:${appUrl}`,
  ];

  info(`Running ${project.workerName} at ${appUrl}`);
  info(`Using Hylo backend ${backendUrl}`);

  if (hasPortless()) {
    return runPortless(project.workerName, wranglerArgs, project.root);
  }

  info(`portless is not available; running on http://127.0.0.1:${workerPort}`);
  return runWranglerDev(
    wranglerArgs.map((arg) => (arg.startsWith("${PORT:-") ? workerPort : arg)),
    project.root,
  );
}

async function pathExists(path: string): Promise<boolean> {
  return access(path)
    .then(() => true)
    .catch(() => false);
}

async function ensureDependencies(projectRoot: string): Promise<void> {
  if (await pathExists(resolve(projectRoot, "node_modules"))) return;
  info(`Installing worker dependencies in ${projectRoot}`);
  const code = await runCommand(
    "pnpm",
    ["install", "--lockfile=false", "--ignore-workspace"],
    projectRoot,
  );
  if (code !== 0) {
    throw new Error(`Dependency install failed with exit code ${code}.`);
  }
}

async function resolvePort(
  envName: string,
  fallback: string,
  reserved = new Set<string>(),
): Promise<string> {
  const explicit = process.env[envName]?.trim();
  if (explicit) {
    const port = parsePort(envName, explicit);
    if (reserved.has(port) || !(await canListen(Number(port)))) {
      throw new Error(`${envName}=${port} is not available on 127.0.0.1.`);
    }
    return port;
  }

  for (let port = Number(fallback); port <= 65535; port += 1) {
    const value = String(port);
    if (reserved.has(value)) continue;
    if (await canListen(port)) return value;
  }

  throw new Error(`No available local port found for ${envName}.`);
}

function parsePort(envName: string, value: string): string {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${envName} must be an integer from 1 to 65535.`);
  }
  return String(port);
}

function canListen(port: number): Promise<boolean> {
  return new Promise((resolveP) => {
    const server = net.createServer();
    server.once("error", () => resolveP(false));
    server.once("listening", () => {
      server.close(() => resolveP(true));
    });
    server.listen({ host: "127.0.0.1", port });
  });
}

function hasPortless(): boolean {
  if (process.env.HYLO_DEV_NO_PORTLESS === "1") return false;
  const result = spawnSync("portless", ["--help"], { stdio: "ignore" });
  return !result.error;
}

function runPortless(
  workerName: string,
  wranglerArgs: string[],
  cwd: string,
): Promise<number> {
  return runCommand(
    "portless",
    [
      "--force",
      workerName,
      "sh",
      "-c",
      [process.execPath, wranglerBin(), ...wranglerArgs]
        .map(shellQuoteCommandPart)
        .join(" "),
    ],
    cwd,
  );
}

function runWranglerDev(args: string[], cwd: string): Promise<number> {
  return runCommand(process.execPath, [wranglerBin(), ...args], cwd);
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
): Promise<number> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: "inherit",
    });
    child.on("error", rejectP);
    child.on("exit", (code) => resolveP(code ?? 1));
  });
}

function shellQuoteCommandPart(value: string): string {
  return value.startsWith("${PORT:-") ? value : shellQuote(value);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
