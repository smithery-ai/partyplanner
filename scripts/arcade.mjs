#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const toolkit = args.find((arg) => !arg.startsWith("-"));

if (!toolkit || args.includes("--help") || args.includes("-h")) {
  run("pnpm", ["arcade:generate", "--help"], { infisical: true });
  process.exit(0);
}

const outDir = flagValue(args, "--out") ?? defaultOutDir(toolkit);
const packageJsonPath = resolve(outDir, "package.json");

run("pnpm", ["arcade:generate", "--force", ...args], { infisical: true });
run("pnpm", ["install"]);
run("pnpm", ["exec", "biome", "check", "--write", outDir]);

if (existsSync(packageJsonPath)) {
  const packageJson = await importJson(packageJsonPath);
  if (packageJson.name) {
    run("pnpm", ["--filter", `${packageJson.name}...`, "build"]);
  }
}

function flagValue(items, flag) {
  const index = items.indexOf(flag);
  if (index !== -1) return items[index + 1];
  const inline = items.find((item) => item.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1) : undefined;
}

function defaultOutDir(value) {
  return `packages/integrations/${slugify(value)}`;
}

function slugify(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function importJson(path) {
  return JSON.parse(
    await import("node:fs/promises").then(({ readFile }) =>
      readFile(path, "utf8"),
    ),
  );
}

function run(command, commandArgs, opts = {}) {
  const finalCommand = opts.infisical ? "infisical" : command;
  const finalArgs = opts.infisical
    ? ["run", "--path=/", "--env=dev", "--", command, ...commandArgs]
    : commandArgs;

  const result = spawnSync(finalCommand, finalArgs, {
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
