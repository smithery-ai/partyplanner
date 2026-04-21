#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const hyloScriptPath = fileURLToPath(import.meta.url);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const BACKENDS = loadBackendConfigs();
const WORKFLOWS = loadWorkflowConfigs();

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

  if (commandName === "deploy") {
    runDeployCommand(rest);
    return;
  }

  if (commandName === "env") {
    printEnv(rest);
    return;
  }

  die(`unknown command "${commandName}". Use run, dev, deploy, exec, or env.`);
}

function runCommand(mode, args) {
  const parsed = parseOptions(args);

  if (parsed.help) {
    printCommandHelp(mode);
    process.exit(0);
  }

  if (parsed.workflow) {
    die(`--workflow is only supported by hylo dev, not hylo ${mode}.`);
  }

  if (parsed.command.length === 0) {
    die(
      `missing command to ${mode}. Usage: hylo ${mode} [options] -- <command...>`,
    );
  }

  const packageConfig = readCurrentPackageHyloConfig();
  const backendUrl = resolveBackendUrl(parsed, {
    fallbackBackend: packageConfig.backend ? "." : undefined,
  });
  const env = {
    ...process.env,
    HYLO_BACKEND_URL: backendUrl,
  };
  const command = prepareCommand(parsed.command, env);

  spawnAndExit(command, env);
}

function runDevCommand(args) {
  const parsed = parseOptions(args, { requireSeparator: false });

  if (parsed.help) {
    printDevHelp();
    process.exit(0);
  }

  const packageConfig = readCurrentPackageHyloConfig();
  const workflow = resolveDevWorkflow(parsed);
  const app = resolveDevApp(parsed);
  const devCommand = resolveDevCommand(parsed, { app, workflow });
  const serviceDevUrl = parsed.url?.trim() || packageConfig.devUrl?.trim();
  const devUrl = serviceDevUrl || app?.devUrl;
  const appUrl = isHttpUrl(devUrl) ? validateHttpUrl(devUrl, "dev url") : "";
  const name = serviceDevUrl ? devServiceNameFromUrl(serviceDevUrl) : undefined;

  const backend = resolveDevBackend(parsed, packageConfig);
  const env = {
    ...process.env,
    HYLO_BACKEND_URL: backend.url,
    ...(backend.packagePath ? { HYLO_BACKEND: backend.packagePath } : {}),
    ...(app?.packagePath ? { HYLO_APP: app.packagePath } : {}),
    ...(workflow?.value ? { HYLO_WORKFLOW: workflow.value } : {}),
    ...(appUrl ? { HYLO_APP_URL: appUrl } : {}),
  };
  const isGraphDev = Boolean(app && workflow && !parsed.separator);
  const managedBackend = startManagedDevBackend(backend, { quiet: isGraphDev });
  printDevSummary({
    app,
    appUrl,
    backend,
    workflow,
  });
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

function runDeployCommand(args) {
  if (args.includes("--help") || args.includes("-h")) {
    printDeployHelp();
    process.exit(0);
  }

  const [targetType, targetName, ...rest] = args;
  if (!targetType) {
    printDeployHelp();
    process.exit(0);
  }

  if (targetType === "--backend" || targetType === "--workflow") {
    die(
      "deploy target type is positional. Use hylo deploy backend <path> or hylo deploy workflow <path>.",
    );
  }

  if (!["backend", "workflow"].includes(targetType)) {
    die('deploy target must be "backend" or "workflow".');
  }

  if (!targetName) {
    die(
      `missing ${targetType} target. Usage: hylo deploy ${targetType} <path>`,
    );
  }

  if (rest.length > 0) {
    die("deploy does not accept a command after the target name.");
  }

  if (targetType === "backend") {
    const backend = resolveDeployBackendTarget(targetName);
    runPackageScript({
      env: {
        ...process.env,
        HYLO_BACKEND: backend.packagePath,
      },
      packageDir: backend.packageDir,
      script: "deploy",
      targetLabel: `backend target ${formatPackagePath(backend.packageDir)}`,
    });
    return;
  }

  const workflow = resolveWorkflowTarget(targetName);
  const backendUrl = process.env.HYLO_BACKEND_URL?.trim();
  runPackageScript({
    env: {
      ...process.env,
      HYLO_WORKFLOW: workflow.packagePath,
      ...(backendUrl
        ? { HYLO_BACKEND_URL: validateHttpUrl(backendUrl, "HYLO_BACKEND_URL") }
        : {}),
    },
    packageDir: workflow.packageDir,
    script: "deploy",
    targetLabel: `workflow target ${formatPackagePath(workflow.packageDir)}`,
  });
}

function parseOptions(args, options = {}) {
  const command = [];
  let backend;
  let backendUrl;
  let help = false;
  let separator = false;
  let url;
  let workflow;
  let parsingOptions = true;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (parsingOptions && arg === "--") {
      separator = true;
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

  if (options.requireSeparator !== false && command.length > 0 && !separator) {
    die('expected "--" before the command.');
  }

  return { backend, backendUrl, command, help, separator, url, workflow };
}

function resolveDevCommand(parsed, { app, workflow }) {
  if (parsed.separator) {
    if (parsed.command.length > 0) return parsed.command;
    die("missing command after --.");
  }

  if (app && !workflow) {
    die("hylo dev <app-path> requires --workflow when no command is provided.");
  }

  if (workflow && !app) {
    die(
      "hylo dev --workflow requires an app package path when no command is provided.",
    );
  }

  if (app && workflow?.target) {
    return [
      "turbo",
      "run",
      "dev",
      `--filter=${app.packageName}`,
      `--filter=${workflow.target.packageName}`,
      "--ui=stream",
      "--output-logs=errors-only",
    ];
  }

  if (app && workflow?.all) {
    return [
      "turbo",
      "run",
      "dev",
      `--filter=${app.packageName}`,
      ...WORKFLOWS.map((target) => `--filter=${target.packageName}`),
      "--ui=stream",
      "--output-logs=errors-only",
    ];
  }

  die(
    "missing command to dev. Usage: hylo dev --backend <path> --workflow <path> <app-path>, or hylo dev --backend <path> -- <command...>.",
  );
}

function resolveDevApp(parsed) {
  if (parsed.separator || parsed.command.length === 0) return undefined;
  if (parsed.command.length > 1) {
    die(
      'expected "--" before a command. Without --, hylo dev accepts one app package path.',
    );
  }
  return resolvePackageTarget(parsed.command[0], "app");
}

function resolveDevWorkflow(parsed) {
  const workflow = parsed.workflow?.trim();
  if (!workflow) return undefined;

  if (workflow.toLowerCase() === "all") return { all: true, value: "all" };

  const target = resolveWorkflowTarget(workflow);
  return {
    target,
    value: target.packagePath,
  };
}

function resolvePackageTarget(name, label) {
  const packageDir = resolvePackageDir(name);
  const packageJson = packageJsonAt(packageDir);
  const packageName = String(packageJson.name ?? "").trim();
  if (!packageName) {
    die(`${formatPackagePath(packageDir)} must set package.json name`);
  }
  if (!packageJson.scripts?.dev) {
    die(
      `${label} target ${formatPackagePath(packageDir)} must define a dev script`,
    );
  }

  return {
    devUrl: packageJson.hylo?.devUrl
      ? validateHttpUrl(
          String(packageJson.hylo.devUrl),
          `${packagePath(packageDir)} devUrl`,
        )
      : undefined,
    packageDir,
    packageName,
    packagePath: packagePath(packageDir),
  };
}

function resolveBackendUrl(parsed, options = {}) {
  if (parsed.backendUrl?.trim()) {
    return validateHttpUrl(parsed.backendUrl.trim(), "--backend-url");
  }

  const envUrl = process.env.HYLO_BACKEND_URL?.trim();
  if (envUrl) return validateHttpUrl(envUrl, "HYLO_BACKEND_URL");

  const envBackendName = process.env.HYLO_BACKEND?.trim();
  if (envBackendName) return resolveBackendTarget(envBackendName).url;

  const backendName = parsed.backend?.trim();
  if (backendName) return resolveBackendTarget(backendName).url;

  const fallbackBackend = options.fallbackBackend?.trim();
  if (fallbackBackend) return resolveBackendTarget(fallbackBackend).url;

  dieNoBackend();
}

function resolveDevBackend(parsed, packageConfig) {
  if (parsed.backendUrl?.trim()) {
    return {
      url: resolveBackendUrl(parsed, {
        fallbackBackend: packageConfig.backend ? "." : undefined,
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
    (packageConfig.backend ? "." : undefined);

  if (!backendName) dieNoBackend();

  const backend = resolveBackendTarget(backendName);
  return {
    packagePath: backend.packagePath,
    packageDir: backend.packageDir,
    url: backend.devUrl ?? backend.url,
  };
}

function startManagedDevBackend(backend, options = {}) {
  if (!backend.packagePath || !backend.packageDir) return undefined;
  if (backend.packageDir === process.cwd()) return undefined;

  return spawnChild("pnpm", ["--dir", backend.packageDir, "dev"], process.env, {
    stdio: options.quiet ? "ignore" : "inherit",
  });
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

function resolveBackendTarget(name) {
  if (isHttpUrl(name)) {
    die(
      "backend targets are package paths. Use HYLO_BACKEND_URL for an existing backend endpoint.",
    );
  }

  const packageDir = resolvePackageDir(name);
  const backend = BACKENDS.find(
    (candidate) => candidate.packageDir === packageDir,
  );

  if (!backend) {
    die(
      `"${name}" is not a Hylo backend package. Use ${backendChoices()}, or set HYLO_BACKEND_URL.`,
    );
  }

  return backend;
}

function resolveDeployBackendTarget(name) {
  if (isHttpUrl(name)) {
    die(
      "hylo deploy backend expects a backend package path. Use HYLO_BACKEND_URL for an existing backend endpoint.",
    );
  }
  return resolveBackendTarget(name);
}

function resolveWorkflowTarget(name) {
  const packageDir = resolvePackageDir(name);
  const workflow = WORKFLOWS.find(
    (candidate) => candidate.packageDir === packageDir,
  );

  if (!workflow) {
    die(`"${name}" is not a Hylo workflow package. Use ${workflowChoices()}.`);
  }

  return workflow;
}

function resolvePackageDir(value) {
  const packageDir = resolve(process.cwd(), value);
  const packageJsonPath = join(packageDir, "package.json");
  if (!existsSync(packageJsonPath)) {
    die(`target path "${value}" must point to a package directory.`);
  }
  return packageDir;
}

function loadBackendConfigs() {
  const appsDir = join(repoRoot, "apps");
  const backends = readdirSync(appsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readBackendConfig(join(appsDir, entry.name)))
    .filter(Boolean)
    .sort((left, right) => left.packagePath.localeCompare(right.packagePath));

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

  const listenUrl = String(backend.listenUrl ?? "").trim();

  if (!listenUrl) {
    die(`${packageJsonPath} must set hylo.backend.listenUrl`);
  }

  return {
    packageDir: appDir,
    packagePath: packagePath(appDir),
    url: validateHttpUrl(listenUrl, `${packagePath(appDir)} listenUrl`),
    deployUrl: backend.deployUrl
      ? validateHttpUrl(
          String(backend.deployUrl),
          `${packagePath(appDir)} deploy url`,
        )
      : undefined,
    devUrl: packageJson.hylo?.devUrl
      ? validateHttpUrl(
          String(packageJson.hylo.devUrl),
          `${packagePath(appDir)} devUrl`,
        )
      : undefined,
  };
}

function loadWorkflowConfigs() {
  const packageDirs = ["apps", "examples"].flatMap((directory) => {
    const root = join(repoRoot, directory);
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name));
  });

  return packageDirs
    .map((packageDir) => readWorkflowConfig(packageDir))
    .filter(Boolean)
    .sort((left, right) => left.packagePath.localeCompare(right.packagePath));
}

function readWorkflowConfig(packageDir) {
  const packageJsonPath = join(packageDir, "package.json");
  if (!existsSync(packageJsonPath)) return undefined;

  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const workflow = packageJson.hylo?.workflow;
  if (!workflow) return undefined;
  const packageName = String(packageJson.name ?? "").trim();
  if (!packageName) {
    die(`${packageJsonPath} must set name for hylo workflow dev orchestration`);
  }

  return {
    devUrl: packageJson.hylo?.devUrl
      ? validateHttpUrl(
          String(packageJson.hylo.devUrl),
          `${packagePath(packageDir)} devUrl`,
        )
      : undefined,
    packageDir,
    packagePath: packagePath(packageDir),
    packageName,
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

function printDevSummary({ app, appUrl, backend, workflow }) {
  if (!app || !workflow) return;

  const lines = [
    "hylo dev",
    `  open:     ${appUrl || "(app server will print its local URL)"}`,
    `  workflow: ${workflow.all ? "all" : (workflow.target?.devUrl ?? workflow.value)}`,
    `  backend:  ${backend.url}`,
    "  stop:     Ctrl+C",
    "",
  ];
  process.stderr.write(`${lines.join("\n")}\n`);
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

function spawnChild(command, args, env, options = {}) {
  return spawn(command, args, {
    detached: process.platform !== "win32",
    stdio: options.stdio ?? "inherit",
    env,
    shell: process.platform === "win32",
  });
}

function spawnAndExit(command, env, managedChildren = []) {
  const child = spawnChild(command[0], command.slice(1), env);
  const children = [...managedChildren, child];
  let shuttingDown = false;

  const signalHandlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => {
      shuttingDown = true;
      for (const currentChild of children) {
        terminateChild(currentChild, signal);
      }
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }

  for (const managedChild of managedChildren) {
    managedChild.on("exit", (code, signal) => {
      if (shuttingDown || childHasExited(child)) return;
      if (signal) terminateChild(child, signal);
      else if (code && code !== 0) terminateChild(child, "SIGTERM");
    });
  }

  child.on("error", (error) => {
    die(`failed to start "${command[0]}": ${error.message}`);
  });

  child.on("exit", (code, signal) => {
    removeSignalHandlers(signalHandlers);
    if (signal) {
      shuttingDown = true;
      for (const managedChild of managedChildren) {
        terminateChild(managedChild, signal);
      }
      process.exit(signalExitCode(signal));
      return;
    }
    shuttingDown = true;
    for (const managedChild of managedChildren) {
      terminateChild(managedChild, "SIGTERM");
    }
    process.exit(code ?? 0);
  });
}

function childHasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function removeSignalHandlers(signalHandlers) {
  for (const [signal, handler] of signalHandlers) {
    process.off(signal, handler);
  }
}

function terminateChild(child, signal) {
  if (childHasExited(child)) return;

  try {
    if (process.platform === "win32") {
      child.kill(signal);
      return;
    }
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") {
      throw error;
    }
  }
}

function signalExitCode(signal) {
  const codes = { SIGINT: 130, SIGTERM: 143 };
  return codes[signal] ?? 1;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function backendChoices() {
  return BACKENDS.map((backend) => formatPackagePath(backend.packageDir)).join(
    ", ",
  );
}

function workflowChoices() {
  return WORKFLOWS.map((workflow) =>
    formatPackagePath(workflow.packageDir),
  ).join(", ");
}

function packagePath(packageDir) {
  return relative(repoRoot, packageDir);
}

function formatPackagePath(packageDir) {
  return `./${packagePath(packageDir)}`;
}

function packageJsonAt(packageDir) {
  const packageJsonPath = join(packageDir, "package.json");
  if (!existsSync(packageJsonPath)) {
    die(`${packageJsonPath} does not exist`);
  }
  return JSON.parse(readFileSync(packageJsonPath, "utf8"));
}

function printDeployTarget(packageDir, targetLabel) {
  console.error(
    `hylo: deploying ${targetLabel} from ${formatPackagePath(packageDir)}`,
  );
}

function runPackageScript({ env, packageDir, script, targetLabel }) {
  const packageJson = packageJsonAt(packageDir);
  if (!packageJson.scripts?.[script]) {
    die(`${targetLabel} does not define a "${script}" script.`);
  }

  printDeployTarget(packageDir, targetLabel);

  const result = spawnSync("pnpm", ["--dir", packageDir, script], {
    stdio: "inherit",
    env,
    shell: process.platform === "win32",
  });

  if (result.error) {
    die(`failed to run ${script} for ${targetLabel}: ${result.error.message}`);
  }

  if (result.signal) {
    process.kill(process.pid, result.signal);
    setTimeout(() => process.exit(1), 128).unref();
    return;
  }

  if (result.status && result.status !== 0) {
    process.exit(result.status);
  }
}

function dieNoBackend() {
  console.error(`hylo: no backend configured.

Set one of:
  HYLO_BACKEND_URL=https://...
  HYLO_BACKEND=./apps/backend-node
  --backend ./apps/backend-node

Examples:
  hylo run --backend ./apps/backend-node -- npm start
  hylo run --backend ./apps/backend-cloudflare -- npm start
  HYLO_BACKEND_URL=https://api.example.com hylo run -- npm start`);
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
  hylo dev  [options] [<app-path> | -- <server command...>]
  hylo deploy <target-type> <package-path>
  hylo exec [options] -- <one-off command...>
  hylo env  [options]

Commands:
  run       Launch a long-running workflow server with HYLO_BACKEND_URL.
  dev       Launch local dev with HYLO_BACKEND_URL.
  deploy    Deploy a backend or workflow package by running its package script.
  exec      Run a one-off command with HYLO_BACKEND_URL.
  env       Print the resolved Hylo environment.

Backend options:
  --backend <path>        Backend package path.
                          Choices: ${backendChoices()}

Workflow option:
  --workflow <path>       Workflow package path. Choices: ${workflowChoices()}, all.

Environment:
  HYLO_BACKEND_URL        Explicit backend URL. Overrides backend targets.
  HYLO_BACKEND            Backend package path.
  HYLO_WORKFLOW           Workflow package path.
  HYLO_APP_URL            Current app URL when hylo.devUrl is set.
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
  --backend <path>        Backend package path. Choices: ${backendChoices()}.

Environment:
  HYLO_BACKEND_URL        Explicit backend URL. Overrides backend targets.

hylo ${mode} does not accept --workflow. The command after -- is the server or
one-off task being launched.
`);
}

function printDevHelp() {
  console.log(`hylo dev

Usage:
  hylo dev [options] [<app-path> | -- <command...>]

Runs local development with HYLO_BACKEND_URL injected. With an app path and
--workflow, Hylo starts those explicit packages through Turbo. With a command
after --, Hylo launches that command directly. When
--url or package.json hylo.devUrl is set, the process is also registered at
that stable local URL. Selected local backends are started automatically. Use
HYLO_BACKEND_URL for an already-running or deployed backend.

Options:
  --url <url>             Local dev URL or service name. Defaults to package Hylo metadata.
  --backend <path>        Backend package path. Choices: ${backendChoices()}.
  --workflow <path>       Workflow package path. Choices: ${workflowChoices()}, all.

Environment:
  HYLO_BACKEND_URL        Explicit backend URL. Overrides backend targets.
`);
}

function printDeployHelp() {
  console.log(`hylo deploy

Usage:
  hylo deploy workflow <package-path>
  hylo deploy backend <package-path>

Deploys one explicit package by running that package's deploy script.

Targets:
  workflow <path>         User workflow service. Choices: ${workflowChoices()}.
  backend <path>          Self-hosted Hylo backend API. Choices: ${backendChoices()}.

Typical:
  hylo deploy workflow ./examples/nextjs
  hylo deploy backend ./apps/backend-cloudflare

hylo deploy does not deploy the browser client in this repo.
`);
}

function printEnvHelp() {
  console.log(`hylo env

Usage:
  hylo env [options]

Prints resolved Hylo environment variables.

Options:
  --backend <path>        Backend package path. Choices: ${backendChoices()}.

Environment:
  HYLO_BACKEND_URL        Explicit backend URL. Overrides backend targets.
`);
}
