#!/usr/bin/env node
import { deploy } from "./commands/deploy.js";
import { dev } from "./commands/dev.js";
import { init } from "./commands/init.js";
import { log } from "./log.js";

const [, , command, ...rest] = process.argv;

function printHelp(): void {
  console.log(
    `workflow — scaffold, run, and deploy Workflow apps on Cloudflare.

Usage:
  workflow <command> [options]

Commands:
  init <name>      Scaffold a new workflow app in ./<name>
  dev [...args]    Generate wrangler.json and run 'wrangler dev'
  deploy [...args] Generate wrangler.json and run 'wrangler deploy'
                   (uses --dispatch-namespace if set in hylo.config.ts)

Extra args after the command are forwarded to wrangler.
`,
  );
}

async function main(): Promise<number> {
  switch (command) {
    case "init":
      return init(rest);
    case "dev":
      return dev(rest);
    case "deploy":
      return deploy(rest);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return 0;
    default:
      log.error(`Unknown command: ${command}`);
      printHelp();
      return 1;
  }
}

main()
  .then((code) => {
    if (code !== 0) process.exit(code);
  })
  .catch((err: unknown) => {
    const message =
      err instanceof Error ? (err.stack ?? err.message) : String(err);
    log.error(message);
    process.exit(1);
  });
