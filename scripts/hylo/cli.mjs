import { die } from "./shared.mjs";
import { runWorkflowCliCommand } from "./workflow-cli.mjs";

export async function main(args) {
  const [commandName, ...rest] = args;

  if (!commandName || commandName === "--help" || commandName === "-h") {
    const { printHelp } = await import("./help.mjs");
    printHelp();
    process.exit(0);
  }

  if (commandName === "cli") {
    runWorkflowCliCommand(rest);
    return;
  }

  const {
    printEnv,
    runCommand,
    runDeployCommand,
    runDevCommand,
    runProfileCommand,
    runTargetCommand,
    runUplinkCommand,
  } = await import("./commands.mjs");

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

  if (commandName === "uplink") {
    await runUplinkCommand(rest);
    return;
  }

  if (commandName === "env") {
    printEnv(rest);
    return;
  }

  if (commandName === "profile") {
    runProfileCommand(rest);
    return;
  }

  if (commandName === "target") {
    runTargetCommand(rest);
    return;
  }

  die(
    `unknown command "${commandName}". Use cli, run, dev, uplink, deploy, exec, env, profile, or target.`,
  );
}
