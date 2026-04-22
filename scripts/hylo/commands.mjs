import { spawnSync } from "node:child_process";
import { devServiceNameFromUrl, portlessBinPath } from "./portless.mjs";
import { spawnAndExit, spawnChild } from "./process.mjs";
import {
  die,
  formatPackagePath,
  shellQuote,
  validateHttpUrl,
} from "./shared.mjs";
import {
  addTarget,
  defaultProfile,
  hasProfile,
  profileApp,
  profileBackend,
  profileChoices,
  profileWorkflows,
  resolveCurrentTarget,
  resolveProfile,
  resolveTarget,
  targetRuntimeUrl,
  updateProfileTargets,
} from "./workspace.mjs";

export function runCommand(mode, args) {
  const parsed = parseProfileCommandArgs(args, { requireSeparator: true });

  if (parsed.help) {
    printCommandHelp(mode);
    process.exit(0);
  }

  if (parsed.command.length === 0) {
    die(
      `missing command to ${mode}. Usage: hylo ${mode} [profile] -- <command...>`,
    );
  }

  const profile = selectedProfile(parsed.profile);
  const currentTarget = resolveCurrentTarget();
  const env = {
    ...process.env,
    ...profileEnv(profile),
    ...(currentTarget ? targetEnv(currentTarget) : {}),
  };

  spawnAndExit(parsed.command, env);
}

export function runDevCommand(args) {
  const parsed = parseProfileCommandArgs(args, { requireSeparator: false });

  if (parsed.help) {
    printDevHelp();
    process.exit(0);
  }

  const profile = selectedProfile(parsed.profile);
  const currentTarget = resolveCurrentTarget();

  if (parsed.separator) {
    if (parsed.command.length === 0) die("missing command after --.");
    runSingleDevCommand(parsed.command, profile, currentTarget);
    return;
  }

  const targets =
    parsed.command.length > 0
      ? uniqueTargets(
          parsed.command.flatMap((targetName) =>
            withProfileDependencies(profile, resolveTarget(targetName)),
          ),
        )
      : currentTarget && !parsed.profile
        ? withProfileDependencies(profile, currentTarget)
        : profile.targets;
  runDevTargets(profile, targets);
}

export function printEnv(args) {
  const parsed = parseProfileCommandArgs(args, { requireSeparator: false });

  if (parsed.help) {
    printEnvHelp();
    process.exit(0);
  }

  if (parsed.separator || parsed.command.length > 0) {
    die("env accepts only a profile. Usage: hylo env [profile]");
  }

  const profile = selectedProfile(parsed.profile);
  process.stdout.write(formatGroupedEnv(profile, profileEnv(profile)));
}

export function runDeployCommand(args) {
  const parsed = parseProfileCommandArgs(args, { requireSeparator: false });

  if (parsed.help) {
    printDeployHelp();
    process.exit(0);
  }

  if (parsed.separator) {
    die("deploy does not accept a command after --.");
  }

  const profile = selectedProfile(parsed.profile);
  const targets =
    parsed.command.length > 0
      ? parsed.command.map((targetName) => resolveTarget(targetName))
      : profile.targets.filter((target) => target.deploy);

  if (targets.length === 0) {
    die(`profile "${profile.id}" does not include any deployable targets.`);
  }

  const env = {
    ...process.env,
    ...profileEnv(profile),
  };

  for (const target of targets) {
    if (!target.deploy) {
      die(`${target.id} does not define a deploy command in hylo.json.`);
    }
    runTargetShellCommand(
      target,
      deployShellCommand(target, target.deploy, env),
      env,
      "deploying",
    );
  }
}

export function runProfileCommand(args) {
  const [action, profileName, targetName, ...rest] = args;

  if (!action || action === "--help" || action === "-h") {
    printProfileHelp();
    process.exit(0);
  }

  if (!["add", "remove"].includes(action)) {
    die('profile command must be "add" or "remove".');
  }

  if (!profileName || !targetName || rest.length > 0) {
    die(`Usage: hylo profile ${action} <profile> <target>`);
  }

  const target = resolveTarget(targetName);
  if (action === "add") {
    updateProfileTargets(profileName, (targetIds) => {
      if (targetIds.includes(target.id)) return targetIds;
      return [...targetIds, target.id];
    });
    process.stdout.write(`Added ${target.id} to ${profileName}.\n`);
    return;
  }

  updateProfileTargets(profileName, (targetIds, config) =>
    removeTargetWithRequiredKindGuard(targetIds, target, config),
  );
  process.stdout.write(`Removed ${target.id} from ${profileName}.\n`);
}

export function runTargetCommand(args) {
  const [action, targetId, ...rest] = args;

  if (!action || action === "--help" || action === "-h") {
    printTargetHelp();
    process.exit(0);
  }

  if (action !== "add") {
    die('target command must be "add".');
  }

  if (!targetId) {
    die("Usage: hylo target add <target> --path <path> --url <url> [options]");
  }

  const options = parseTargetAddOptions(rest);
  addTarget(targetId, {
    path: options.path,
    provider: options.provider,
    dev: options.dev,
    deploy: options.deploy,
    url: options.url,
  });
  process.stdout.write(`Registered ${targetId} in hylo.json.\n`);
}

function removeTargetWithRequiredKindGuard(targetIds, target, config) {
  const nextTargetIds = targetIds.filter((targetId) => targetId !== target.id);
  if (nextTargetIds.length === targetIds.length) return targetIds;

  if (["app", "backend"].includes(target.kind)) {
    die(`profile must include exactly one ${target.kind} target.`);
  }

  if (target.kind === "workflow") {
    const remainingWorkflows = nextTargetIds.filter(
      (targetId) =>
        config.targets[targetId]?.path && targetId.startsWith("workflow."),
    );
    if (remainingWorkflows.length === 0) {
      die("profile must include at least one workflow target.");
    }
  }

  return nextTargetIds;
}

function runSingleDevCommand(command, profile, currentTarget) {
  const env = {
    ...process.env,
    ...profileEnv(profile),
    ...(currentTarget ? targetEnv(currentTarget) : {}),
  };
  const devUrl = currentTarget?.url;
  const wrappedCommand = wrapPortlessCommand(command, devUrl);
  spawnAndExit(wrappedCommand.command, env, [], {
    cwd: currentTarget?.packageDir,
    exitZeroOnSigint: true,
    filterPortlessOutput: wrappedCommand.filterPortlessOutput,
  });
}

function runDevTargets(profile, targets) {
  const profileValues = profileEnv(profile, { targets });
  const specs = targets.map((target) => {
    if (!target.dev) {
      die(`${target.id} does not define a dev command in hylo.json.`);
    }
    const env = {
      ...process.env,
      ...profileValues,
      ...targetEnv(target),
    };
    const command = devShellCommand(target, env);
    const wrapped = wrapPortlessCommand(shellCommand(command), target.url);
    return {
      ...wrapped,
      cwd: target.packageDir,
      env,
      target,
    };
  });

  printDevSummary(profile, targets, profileValues);

  const managedSpecs = specs.slice(0, -1);
  const mainSpec = specs.at(-1);
  const managedChildren = managedSpecs.map((spec) =>
    spawnChild(spec.command[0], spec.command.slice(1), spec.env, {
      cwd: spec.cwd,
      filterPortlessOutput: spec.filterPortlessOutput,
    }),
  );

  spawnAndExit(mainSpec.command, mainSpec.env, managedChildren, {
    cwd: mainSpec.cwd,
    exitZeroOnSigint: true,
    filterPortlessOutput: mainSpec.filterPortlessOutput,
  });
}

function selectedProfile(profileName) {
  if (profileName) return resolveProfile(profileName);
  const profile = defaultProfile();
  if (!profile) {
    die("no profile selected. Set hylo.json defaultProfile or pass a profile.");
  }
  return profile;
}

function parseProfileCommandArgs(args, options) {
  const command = [];
  let help = false;
  let profile;
  let separator = false;
  let parsingOptions = true;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];

    if (parsingOptions && arg === "--") {
      separator = true;
      parsingOptions = false;
      continue;
    }

    if (parsingOptions && (arg === "--help" || arg === "-h")) {
      help = true;
      continue;
    }

    if (parsingOptions && arg === "--profile") {
      const value = args[++index];
      if (!value) die("--profile requires a value.");
      profile = value;
      continue;
    }

    if (parsingOptions && arg.startsWith("--profile=")) {
      profile = arg.slice("--profile=".length);
      continue;
    }

    if (parsingOptions && !profile && hasProfile(arg)) {
      profile = arg;
      continue;
    }

    parsingOptions = false;
    command.push(arg);
  }

  if (options.requireSeparator && command.length > 0 && !separator) {
    die('expected "--" before the command.');
  }

  return { command, help, profile, separator };
}

function profileEnv(profile, options = {}) {
  const backend = profileBackend(profile);
  const app = profileApp(profile);
  const workflows = selectedWorkflowTargets(profile, options.targets);
  const backendUrl = targetRuntimeUrl(backend, profile);
  const appUrl = optionalTargetRuntimeUrl(app, profile);
  const workflowEntries = workflows.map((workflow) => ({
    id: workflow.id,
    path: workflow.packagePath,
    url: workflowApiUrl(targetRuntimeUrl(workflow, profile)),
  }));
  const defaultWorkflow = workflowEntries[0];
  const workflowRegistry = workflowRegistryEnv(
    workflowEntries,
    defaultWorkflow?.id,
  );

  return removeEmpty({
    HYLO_PROFILE: profile.id,
    HYLO_BACKEND: backend.packagePath,
    HYLO_BACKEND_PUBLIC_URL: backendUrl,
    HYLO_BACKEND_URL: backendUrl,
    HYLO_APP: app.packagePath,
    HYLO_APP_URL: appUrl,
    HYLO_WORKFLOW: defaultWorkflow?.path,
    HYLO_WORKFLOW_URL: defaultWorkflow?.url,
    HYLO_WORKFLOWS: workflowRegistry,
    VITE_HYLO_WORKFLOW: defaultWorkflow?.id,
    VITE_HYLO_WORKFLOW_URL: defaultWorkflow?.url,
    VITE_HYLO_WORKFLOWS: workflowRegistry,
  });
}

function targetEnv(target) {
  return removeEmpty({
    HYLO_TARGET: target.id,
    ...(target.kind === "backend"
      ? {
          HYLO_BACKEND: target.packagePath,
          HYLO_BACKEND_PUBLIC_URL: target.url,
          HYLO_BACKEND_URL: target.url,
        }
      : {}),
    ...(target.kind === "workflow"
      ? { HYLO_WORKFLOW: target.packagePath }
      : {}),
    ...(target.kind === "app" ? { HYLO_APP: target.packagePath } : {}),
  });
}

function optionalTargetRuntimeUrl(target, profile) {
  const value =
    profile.urls?.[target.id] ??
    (profile.id === "local" ? target.url : undefined);
  return value ? validateHttpUrl(value, `${target.id} url`) : undefined;
}

function workflowRegistryEnv(workflows, defaultWorkflow) {
  return JSON.stringify({
    defaultWorkflow:
      workflows.find((workflow) => workflow.id === defaultWorkflow)?.id ??
      workflows[0]?.id,
    workflows: Object.fromEntries(
      workflows.map((workflow) => [
        workflow.id,
        {
          label: workflowLabel(workflow.id),
          url: workflow.url,
        },
      ]),
    ),
  });
}

function workflowApiUrl(value) {
  const url = new URL(validateHttpUrl(value, "workflow url"));
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/api/workflow`;
  return url.toString().replace(/\/$/, "");
}

function workflowLabel(id) {
  return id
    .replace(/^[^.]+\./, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[-_.\s]/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

function devShellCommand(target, env) {
  let command = target.dev;
  if (
    target.provider === "cloudflare-worker" &&
    /\bwrangler\s+dev\b/.test(command)
  ) {
    command = appendWranglerVars(command, env);
  }
  return command;
}

function deployShellCommand(target, command, env) {
  if (
    target.kind === "workflow" &&
    target.provider === "cloudflare-worker" &&
    /\bwrangler\s+deploy\b/.test(command)
  ) {
    return appendWranglerDeployVars(command, env);
  }
  return command;
}

function appendWranglerVars(command, env) {
  let next = command;
  for (const name of ["HYLO_BACKEND_URL", "HYLO_APP_URL"]) {
    if (!env[name]) continue;
    next += ` --var ${shellQuote(`${name}:${env[name]}`)}`;
  }
  return next;
}

function appendWranglerDeployVars(command, env) {
  let next = command;
  if (!/\s--keep-vars(\s|$)/.test(next)) {
    next += " --keep-vars";
  }
  return appendWranglerVars(next, env);
}

function runTargetShellCommand(target, command, env, verb) {
  process.stderr.write(
    `hylo: ${verb} ${target.id} from ${formatPackagePath(target.packageDir)}\n`,
  );
  const result = spawnSyncShell(command, env, target.packageDir);
  if (result.error) {
    die(`failed to run ${target.id}: ${result.error.message}`);
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

function spawnSyncShell(command, env, cwd) {
  const shell = shellCommand(command);
  return spawnSync(shell[0], shell.slice(1), {
    cwd,
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
}

function shellCommand(command) {
  const shell = process.env.SHELL || "sh";
  return [shell, "-lc", command];
}

function wrapPortlessCommand(command, url) {
  if (!url) {
    return { command, filterPortlessOutput: false };
  }
  return {
    command: [
      process.execPath,
      portlessBinPath(),
      "run",
      "--force",
      "--name",
      devServiceNameFromUrl(url),
      ...command,
    ],
    filterPortlessOutput: true,
  };
}

function formatGroupedEnv(profile, env) {
  const sections = [
    ["profile", ["HYLO_PROFILE"]],
    [
      "backend",
      ["HYLO_BACKEND", "HYLO_BACKEND_URL", "HYLO_BACKEND_PUBLIC_URL"],
    ],
    ["workflows", ["HYLO_WORKFLOW", "HYLO_WORKFLOW_URL", "HYLO_WORKFLOWS"]],
    [
      "app",
      [
        "HYLO_APP",
        "HYLO_APP_URL",
        "VITE_HYLO_WORKFLOW",
        "VITE_HYLO_WORKFLOW_URL",
        "VITE_HYLO_WORKFLOWS",
      ],
    ],
  ];
  const lines = [`# hylo ${profile.id}`];
  for (const [title, keys] of sections) {
    lines.push("", `# ${title}`);
    for (const key of keys) {
      if (env[key]) lines.push(`${key}=${shellQuote(String(env[key]))}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function printDevSummary(profile, targets, env) {
  const lines = [
    `hylo dev ${profile.id}`,
    `  app:      ${env.HYLO_APP_URL ?? "(not exposed)"}`,
    `  backend:  ${env.HYLO_BACKEND_URL}`,
    `  workflow: ${env.HYLO_WORKFLOW_URL}`,
    `  targets:  ${targets.map((target) => target.id).join(", ")}`,
    "  stop:     Ctrl+C",
    "",
  ];
  process.stderr.write(`${lines.join("\n")}\n`);
}

function withProfileDependencies(profile, target) {
  if (target.kind === "backend") return [target];
  const dependencies = [profileBackend(profile)];
  if (target.kind === "app") dependencies.push(...profileWorkflows(profile));
  return [...dependencies, target];
}

function selectedWorkflowTargets(profile, targets) {
  const workflows =
    targets?.filter((target) => target.kind === "workflow") ?? [];
  return workflows.length > 0 ? workflows : profileWorkflows(profile);
}

function uniqueTargets(targets) {
  const seen = new Set();
  return targets.filter((target) => {
    if (seen.has(target.id)) return false;
    seen.add(target.id);
    return true;
  });
}

function printCommandHelp(mode) {
  const kind = mode === "run" ? "long-running process" : "one-off command";
  console.log(`hylo ${mode}

Usage:
  hylo ${mode} [profile] -- <command...>

Runs a ${kind} with the environment resolved from hylo.json.
Profiles: ${profileChoices()}
`);
}

function printDevHelp() {
  console.log(`hylo dev

Usage:
  hylo dev [profile] [target...]

Starts the configured local targets for a profile. From a target directory,
hylo dev starts that target with profile env injected. Passing target ids starts
those targets and their required local dependencies.

Profiles: ${profileChoices()}
`);
}

function printDeployHelp() {
  console.log(`hylo deploy

Usage:
  hylo deploy [profile] [target...]

Deploys the deployable targets in a profile, or the listed targets, using
commands from hylo.json.

Profiles: ${profileChoices()}
`);
}

function printEnvHelp() {
  console.log(`hylo env

Usage:
  hylo env [profile]

Prints the Hylo environment resolved from hylo.json.
Profiles: ${profileChoices()}
`);
}

function printProfileHelp() {
  console.log(`hylo profile

Usage:
  hylo profile add <profile> <target>
  hylo profile remove <profile> <target>

Adds or removes a target from a profile in hylo.json.
Profiles: ${profileChoices()}
`);
}

function printTargetHelp() {
  console.log(`hylo target

Usage:
  hylo target add <target> --path <path> --url <url> [options]

Options:
  --provider <name>
  --dev <command>
  --deploy <command>

Example:
  hylo target add workflow.someWorker --path ./examples/some-worker --url https://some-worker.hylo.localhost
`);
}

function parseTargetAddOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--path") {
      options.path = requiredOptionValue(args, ++index, "--path");
      continue;
    }
    if (arg.startsWith("--path=")) {
      options.path = arg.slice("--path=".length);
      continue;
    }
    if (arg === "--url") {
      options.url = requiredOptionValue(args, ++index, "--url");
      continue;
    }
    if (arg.startsWith("--url=")) {
      options.url = arg.slice("--url=".length);
      continue;
    }
    if (arg === "--provider") {
      options.provider = requiredOptionValue(args, ++index, "--provider");
      continue;
    }
    if (arg.startsWith("--provider=")) {
      options.provider = arg.slice("--provider=".length);
      continue;
    }
    if (arg === "--dev") {
      options.dev = requiredOptionValue(args, ++index, "--dev");
      continue;
    }
    if (arg.startsWith("--dev=")) {
      options.dev = arg.slice("--dev=".length);
      continue;
    }
    if (arg === "--deploy") {
      options.deploy = requiredOptionValue(args, ++index, "--deploy");
      continue;
    }
    if (arg.startsWith("--deploy=")) {
      options.deploy = arg.slice("--deploy=".length);
      continue;
    }
    die(`unknown target option "${arg}".`);
  }

  if (!options.path) die("--path is required.");
  if (!options.url) die("--url is required.");
  return options;
}

function requiredOptionValue(args, index, option) {
  const value = args[index];
  if (!value) die(`${option} requires a value.`);
  return value;
}

function removeEmpty(values) {
  return Object.fromEntries(
    Object.entries(values).filter(
      ([, value]) => value !== undefined && value !== "",
    ),
  );
}
