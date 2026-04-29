#!/usr/bin/env node
import { execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const flamecastRoot = process.env.FLAMECAST_LOG_DIR
  ? resolve(process.env.FLAMECAST_LOG_DIR)
  : resolve(homedir(), ".flamecast");
const localWorkerDir = resolve(flamecastRoot, "worker");
const env = { ...process.env, ...loadInfisicalDevEnv() };

if (!existsSync(resolve(localWorkerDir, "package.json"))) {
  console.log(
    `No local worker found at ${localWorkerDir}; scaffolding it now...`,
  );
  execSync("pnpm hylo init --force", {
    env,
    stdio: "inherit",
  });
}

const child = spawn("pnpm", ["hylo", "dev", "--local", localWorkerDir], {
  env,
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.exit(1);
    return;
  }
  process.exit(code ?? 0);
});

child.on("error", (error) => {
  console.error(`Failed to start local worker dev server: ${error.message}`);
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    child.kill(signal);
  });
}

function loadInfisicalDevEnv() {
  if (process.env.HYLO_SKIP_INFISICAL_ENV === "1") return {};
  try {
    const output = execSync(
      "infisical export --path=/ --env=dev --format=dotenv",
      {
        env: process.env,
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      },
    );
    return parseDotenv(output);
  } catch {
    return {};
  }
}

function parseDotenv(source) {
  const result = {};
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equals = trimmed.indexOf("=");
    if (equals <= 0) continue;
    const key = trimmed.slice(0, equals).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    result[key] = unquoteDotenvValue(trimmed.slice(equals + 1).trim());
  }
  return result;
}

function unquoteDotenvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
