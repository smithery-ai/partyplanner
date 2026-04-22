import {
  printEnv,
  runCommand,
  runDeployCommand,
  runDevCommand,
  runProfileCommand,
  runTargetCommand,
  runUplinkCommand,
} from "./commands.mjs";
import { printHelp } from "./help.mjs";
import { die } from "./shared.mjs";

export function main(args) {
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

  if (commandName === "uplink") {
    runUplinkCommand(rest);
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
    `unknown command "${commandName}". Use run, dev, uplink, deploy, exec, env, profile, or target.`,
  );
}
