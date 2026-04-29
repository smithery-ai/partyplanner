#!/usr/bin/env node
import { runAuth } from "./commands/auth.js";
import { runBuild } from "./commands/build.js";
import { runDeploy } from "./commands/deploy.js";
import { runDeployments } from "./commands/deployments.js";
import { runDev } from "./commands/dev.js";
import { runInit } from "./commands/init.js";
import { runOrganizations } from "./commands/organizations.js";
import { runRuns } from "./commands/runs.js";
import { runWorkers } from "./commands/workers.js";

const HELP = `hylo — workflow CLI

Usage:
  hylo auth <command>                Sign in with WorkOS AuthKit
  hylo init [--force]                Create ~/.flamecast/worker example Worker
  hylo dev [dir] [--local]           Run a Hylo Worker locally
  hylo build [dir] [--local]         Bundle into a Cloudflare Worker
  hylo deploy [dir] [--local]
                                      Build and deploy via Hylo API
  hylo deployments <command>         Call the deployment API
  hylo organizations <command>       List authenticated organizations
  hylo workers <command>             List workflow workers
  hylo runs <command>                List or fetch workflow runs
  hylo --help                        Show this help

Options:
  --local                  Use the portless local Hylo backend
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return 0;
  }

  switch (command) {
    case "auth":
      return runAuth(rest);
    case "init":
      return runInit(rest);
    case "dev":
      return runDev(rest);
    case "build":
      return runBuild(rest);
    case "deploy":
      return runDeploy(rest);
    case "deployments":
      return runDeployments(rest);
    case "organizations":
      return runOrganizations(rest);
    case "workers":
      return runWorkers(rest);
    case "runs":
      return runRuns(rest);
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(
      `${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  },
);
