#!/usr/bin/env node
import { runAuth } from "./commands/auth.js";
import { runBuild } from "./commands/build.js";
import { runDeploy } from "./commands/deploy.js";
import { runDeployments } from "./commands/deployments.js";
import { runInit } from "./commands/init.js";

const HELP = `hylo — workflow CLI

Usage:
  hylo auth <command>                Sign in with WorkOS AuthKit
  hylo init [dir]                    Create a new workflow project
  hylo build [--backend <url>]       Bundle into a Cloudflare Worker
  hylo deploy [dir] [--backend <url>] Build and deploy via Hylo API
  hylo deployments <command>         Call the deployment API
  hylo --help                        Show this help

Options:
  --backend <url>          Hylo backend API URL
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
    case "build":
      return runBuild(rest);
    case "deploy":
      return runDeploy(rest);
    case "deployments":
      return runDeployments(rest);
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
