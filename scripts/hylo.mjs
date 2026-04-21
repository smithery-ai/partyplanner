#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const hyloScriptPath = fileURLToPath(import.meta.url);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const BACKENDS = loadBackendConfigs();
const WORKFLOWS = ["nextjs", "cloudflare-worker", "all"];

main(process.argv.slice(2));

function main(args) {
  const [commandName, ...rest] = args;

  if (!commandName || commandName === "--help" || commandName === "-h") {
    printHelp();
    process.exit(0);
  }

  if (commandName === "run" || commandName === "exec") {
    runCommand(commandName, rest);
    return;
  }

  if (commandName === "dev") {
    runDevCommand(rest);
    return;
  }

  if (commandName === "env") {
    printEnv(rest);
    return;
  }

  die(`unknown command "${commandName}". Use run, dev, exec, or env.`);
}

function runCommand(mode, args) {
  const parsed = parseOptions(args);

  if (parsed.help) {
    printCommandHelp(mode);
    process.exit(0);
  }

  if (parsed.workflow) {
    die(
      `--workflow is only supported by hylo dev orchestration, not hylo ${mode}.`,
    );
  }

  if (parsed.command.length === 0) {
    die(
      `missing command to ${mode}. Usage: hylo ${mode} [options] -- <command...>`,
    );
  }

  const packageConfig = readCurrentPackageHyloConfig();
  const backendUrl = resolveBackendUrl(parsed, {
    fallbackBackend: packageConfig.backend?.id,
  });
  const env = {
    ...process.env,
    HYLO_BACKEND_URL: backendUrl,
  };
  const command = prepareCommand(parsed.command, env);

  spawnAndExit(command, env);
}

function runDevCommand(args) {
  const parsed = parseOptions(args);

  if (parsed.help) {
    printDevHelp();
    process.exit(0);
  }

  const packageConfig = readCurrentPackageHyloConfig();
  const workflow = resolveWorkflow(parsed);
  const devCommand = resolveDevCommand(parsed);
  const devUrl = parsed.url?.trim() || packageConfig.dev?.url?.trim();
  const appUrl = isHttpUrl(devUrl) ? validateHttpUrl(devUrl, "dev url") : "";
  const name = devUrl ? devServiceNameFromUrl(devUrl) : undefined;

  const backend = resolveDevBackend(parsed, packageConfig);
  const env = {
    ...process.env,
    HYLO_BACKEND_URL: backend.url,
    ...(backend.id ? { HYLO_BACKEND: backend.id } : {}),
    ...(workflow ? { HYLO_WORKFLOW: workflow } : {}),
    ...(appUrl ? { HYLO_APP_URL: appUrl } : {}),
  };
  const managedBackend = startManagedDevBackend(backend, packageConfig);
  const command = name
    ? [
        process.execPath,
        portlessBinPath(),
        "run",
        "--force",
        "--name",
        name,
        process.execPath,
        hyloScriptPath,
        "run",
        "--backend-url",
        backend.url,
        "--",
        ...devCommand,
      ]
    : prepareCommand(devCommand, env);

  spawnAndExit(command, env, managedBackend ? [managedBackend] : []);
}

function printEnv(args) {
  const parsed = parseOptions(args, { requireSeparator: false });

  if (parsed.help) {
    printEnvHelp();
    process.exit(0);
  }

  if (parsed.command.length > 0) {
    die("env does not accept a command. Usage: hylo env [options]");
  }

  const backendUrl = resolveBackendUrl(parsed);
  process.stdout.write(`HYLO_BACKEND_URL=${shellQuote(backendUrl)}\n`);
}

function parseOptions(args, options = {}) {
  const command = [];
  let backend;
  let backendUrl;
  let help = false;
  let url;
  let workflow;
  let parsingOptions = true;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (parsingOptions && arg === "--") {
      parsingOptions = false;
      continue;
    }

    if (parsingOptions && (arg === "--help" || arg === "-h")) {
      help = true;
      continue;
    }

    if (parsingOptions && arg === "--backend") {
      const value = args[++i];
      if (!value) die("--backend requires a value.");
      backend = value;
      continue;
    }

    if (parsingOptions && arg.startsWith("--backend=")) {
      backend = arg.slice("--backend=".length);
      continue;
    }

    if (parsingOptions && arg === "--backend-url") {
      const value = args[++i];
      if (!value) die("--backend-url requires a value.");
      backendUrl = value;
      continue;
    }

    if (parsingOptions && arg.startsWith("--backend-url=")) {
      backendUrl = arg.slice("--backend-url=".length);
      continue;
    }

    if (parsingOptions && arg === "--url") {
      const value = args[++i];
      if (!value) die("--url requires a value.");
      url = value;
      continue;
    }

    if (parsingOptions && arg.startsWith("--url=")) {
      url = arg.slice("--url=".length);
      continue;
    }

    if (parsingOptions && arg === "--workflow") {
      const value = args[++i];
      if (!value) die("--workflow requires a value.");
      workflow = value;
      continue;
    }

    if (parsingOptions && arg.startsWith("--workflow=")) {
      workflow = arg.slice("--workflow=".length);
      continue;
    }

    parsingOptions = false;
    command.push(arg);
  }

  if (
    options.requireSeparator !== false &&
    parsingOptions &&
    command.length > 0
  ) {
    die('expected "--" before the command.');
  }

  return { backend, backendUrl, command, help, url, workflow };
}

function resolveDevCommand(parsed) {
  if (parsed.command.length > 0) return parsed.command;

  die(
    "missing command to dev. Usage: hylo dev --backend <name|url> [--workflow <name>] -- <command...>.",
  );
}

function resolveWorkflow(parsed) {
  const workflow = parsed.workflow?.trim() || process.env.HYLO_WORKFLOW?.trim();
  if (!workflow) return undefined;

  const normalized = workflow.toLowerCase();
  if (WORKFLOWS.includes(normalized)) {
    return normalized;
  }

  die(`unknown workflow "${workflow}". Use nextjs, cloudflare-worker, or all.`);
}

function resolveBackendUrl(parsed, options = {}) {
  if (parsed.backendUrl?.trim()) {
    return validateHttpUrl(parsed.backendUrl.trim(), "--backend-url");
  }

  if (isHttpUrl(parsed.backend)) {
    return validateHttpUrl(parsed.backend.trim(), "--backend");
  }

  const envUrl = process.env.HYLO_BACKEND_URL?.trim();
  if (envUrl) return validateHttpUrl(envUrl, "HYLO_BACKEND_URL");

  const envBackendName = process.env.HYLO_BACKEND?.trim();
  if (envBackendName) return resolveBackendAlias(envBackendName).url;

  const backendName = parsed.backend?.trim();
  if (backendName) return resolveBackendAlias(backendName).url;

  const fallbackBackend = options.fallbackBackend?.trim();
  if (fallbackBackend) return resolveBackendAlias(fallbackBackend).url;

  dieNoBackend();
}

function resolveDevBackend(parsed, packageConfig) {
  if (parsed.backendUrl?.trim() || isHttpUrl(parsed.backend)) {
    return {
      url: resolveBackendUrl(parsed, {
        fallbackBackend: packageConfig.backend?.id,
      }),
    };
  }

  const envUrl = process.env.HYLO_BACKEND_URL?.trim();
  if (envUrl) {
    return { url: validateHttpUrl(envUrl, "HYLO_BACKEND_URL") };
  }

  const backendName =
    process.env.HYLO_BACKEND?.trim() ||
    parsed.backend?.trim() ||
    packageConfig.backend?.id?.trim();

  if (!backendName) dieNoBackend();

  const backend = resolveBackendAlias(backendName);
  return {
    id: backend.id,
    packageDir: backend.packageDir,
    url: backend.devUrl ?? backend.url,
  };
}

function startManagedDevBackend(backend, packageConfig) {
  if (!backend.id || !backend.packageDir) return undefined;
  if (backend.id === packageConfig.backend?.id) return undefined;

  return spawnChild("pnpm", ["--dir", backend.packageDir, "dev"], process.env);
}

function prepareCommand(command, env) {
  const expanded = command.map((arg) => expandEnvPlaceholders(arg, env));
  if (!isWranglerDevCommand(expanded)) return expanded;

  return withWranglerVars(expanded, env, ["HYLO_BACKEND_URL", "HYLO_APP_URL"]);
}

function expandEnvPlaceholders(value, env) {
  return value.replace(
    /\$([A-Z_][A-Z0-9_]*)/g,
    (_match, name) => env[name] ?? "",
  );
}

function isWranglerDevCommand(command) {
  const executable = command[0]?.split(/[\\/]/).pop();
  return executable === "wrangler" && command.includes("dev");
}

function hasWranglerVar(command, name) {
  return command.some(
    (arg, index) =>
      arg === `--var=${name}` ||
      arg.startsWith(`--var=${name}:`) ||
      (command[index - 1] === "--var" && arg.startsWith(`${name}:`)),
  );
}

function withWranglerVars(command, env, names) {
  const next = [...command];
  for (const name of names) {
    const value = env[name];
    if (!value || hasWranglerVar(next, name)) continue;
    next.push("--var", `${name}:${value}`);
  }
  return next;
}

function resolveBackendAlias(name) {
  const normalized = name.toLowerCase();
  const backend = BACKENDS.find((candidate) => candidate.id === normalized);

  if (!backend) {
    die(
      `unknown backend "${name}". Use ${BACKENDS.map((b) => b.id).join(
        ", ",
      )}, or pass --backend-url <url>.`,
    );
  }

  return backend;
}

function loadBackendConfigs() {
  const appsDir = join(repoRoot, "apps");
  const backends = readdirSync(appsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readBackendConfig(join(appsDir, entry.name)))
    .filter(Boolean)
    .sort((left, right) => left.id.localeCompare(right.id));

  if (backends.length === 0) {
    die(`no backend configs found under ${appsDir}`);
  }

  return backends;
}

function readBackendConfig(appDir) {
  const packageJsonPath = join(appDir, "package.json");
  if (!existsSync(packageJsonPath)) return undefined;

  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const backend = packageJson.hylo?.backend;
  if (!backend) return undefined;

  const id = String(backend.id ?? "").trim();
  const url = String(backend.url ?? "").trim();

  if (!id || !url) {
    die(`${packageJsonPath} must set hylo.backend.id and hylo.backend.url`);
  }

  return {
    id,
    packageDir: appDir,
    url: validateHttpUrl(url, `${id} url`),
    devUrl: packageJson.hylo?.dev?.url
      ? validateHttpUrl(String(packageJson.hylo.dev.url), `${id} dev url`)
      : undefined,
  };
}

function readCurrentPackageHyloConfig() {
  const packageJsonPath = join(process.cwd(), "package.json");
  if (!existsSync(packageJsonPath)) return {};

  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  return packageJson.hylo ?? {};
}

function portlessBinPath() {
  return join(
    dirname(fileURLToPath(import.meta.resolve("portless"))),
    "cli.js",
  );
}

function devServiceNameFromUrl(value) {
  const normalized = value.trim();
  if (!normalized) return undefined;

  try {
    return new URL(normalized).hostname.replace(/\.localhost$/, "");
  } catch {
    return normalized.replace(/^https?:\/\//, "").replace(/\.localhost$/, "");
  }
}

function validateHttpUrl(value, label) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("URL must use http: or https:");
    }
    return url.toString().replace(/\/$/, "");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    die(`invalid ${label} "${value}": ${detail}`);
  }
}

function isHttpUrl(value) {
  if (!value) return false;
  return /^https?:\/\//i.test(value.trim());
}

function spawnChild(command, args, env) {
  return spawn(command, args, {
    stdio: "inherit",
    env,
    shell: process.platform === "win32",
  });
}

function spawnAndExit(command, env, managedChildren = []) {
  const child = spawnChild(command[0], command.slice(1), env);
  const children = [...managedChildren, child];

  const signalHandlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => {
      for (const currentChild of children) {
        if (!currentChild.killed) currentChild.kill(signal);
      }
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }

  for (const managedChild of managedChildren) {
    managedChild.on("exit", (code, signal) => {
      if (child.killed) return;
      if (signal) child.kill(signal);
      else if (code && code !== 0) child.kill("SIGTERM");
    });
  }

  child.on("error", (error) => {
    die(`failed to start "${command[0]}": ${error.message}`);
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      for (const [forwardedSignal, handler] of signalHandlers) {
        process.off(forwardedSignal, handler);
      }
      for (const managedChild of managedChildren) {
        if (!managedChild.killed) managedChild.kill(signal);
      }
      process.kill(process.pid, signal);
      setTimeout(() => process.exit(1), 128).unref();
      return;
    }
    for (const managedChild of managedChildren) {
      if (!managedChild.killed) managedChild.kill("SIGTERM");
    }
    process.exit(code ?? 0);
  });
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function backendChoices() {
  return BACKENDS.map((backend) => backend.id).join(", ");
}

function dieNoBackend() {
  console.error(`hylo: no backend configured.

Set one of:
  HYLO_BACKEND_URL=https://...
  HYLO_BACKEND=node
  --backend node
  --backend-url https://...

Examples:
  hylo run --backend node -- npm start
  hylo run --backend cloudflare -- npm start
  hylo run --backend-url https://api.example.com -- npm start`);
  process.exit(1);
}

function die(message) {
  console.error(`hylo: ${message}`);
  process.exit(1);
}

function printHelp() {
  console.log(`hylo

Usage:
  hylo run  [options] -- <server command...>
  hylo dev  [options] -- <server command...>
  hylo exec [options] -- <one-off command...>
  hylo env  [options]

Commands:
  run       Launch a long-running workflow server with HYLO_BACKEND_URL.
  dev       Launch a local dev command with HYLO_BACKEND_URL.
  exec      Run a one-off command with HYLO_BACKEND_URL.
  env       Print the resolved Hylo environment.

Backend options:
  --backend <name|url>    Backend name or explicit URL.
                          Choices: ${backendChoices()}
  --backend-url <url>     Explicit Hylo backend URL.

Dev orchestration:
  --workflow <name>       Local workflow service. Choices: nextjs, cloudflare-worker, all.

Environment:
  HYLO_BACKEND_URL        Explicit backend URL. Overrides backend names.
  HYLO_BACKEND            Backend name.
  HYLO_WORKFLOW           Local workflow service selection.
  HYLO_APP_URL            Current app URL when hylo.dev.url is set.
`);
}

function printCommandHelp(mode) {
  const kind =
    mode === "run" ? "long-running workflow server" : "one-off command";
  console.log(`hylo ${mode}

Usage:
  hylo ${mode} [options] -- <command...>

Runs a ${kind} with HYLO_BACKEND_URL injected.

Options:
  --backend <name|url>    Backend name or explicit URL.
  --backend-url <url>     Explicit Hylo backend URL.

hylo ${mode} does not accept --workflow. The command after -- is the server or
one-off task being launched.
`);
}

function printDevHelp() {
  console.log(`hylo dev

Usage:
  hylo dev [options] [-- <command...>]

Runs a local development command with HYLO_BACKEND_URL injected. --workflow sets
HYLO_WORKFLOW for commands that need to know the selected workflow service. When
--url or package.json hylo.dev.url is set, the process is also registered at
that stable local URL. Named local backends are started automatically. Use
--backend-url for an already-running or deployed backend.

Options:
  --url <url>             Local dev URL or service name. Defaults to package Hylo metadata.
  --backend <name|url>    Backend name or explicit URL.
  --backend-url <url>     Explicit Hylo backend URL.
  --workflow <name>       Local workflow service. Choices: nextjs, cloudflare-worker, all.
`);
}

function printEnvHelp() {
  console.log(`hylo env

Usage:
  hylo env [options]

Prints resolved Hylo environment variables.

Options:
  --backend <name|url>    Backend name or explicit URL.
  --backend-url <url>     Explicit Hylo backend URL.
`);
}
