import { spawn } from "node:child_process";
import { die } from "./shared.mjs";

export function spawnChild(command, args, env, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    detached: process.platform !== "win32",
    stdio: options.filterPortlessOutput
      ? ["inherit", "pipe", "pipe"]
      : (options.stdio ?? "inherit"),
    env,
    shell: process.platform === "win32",
  });
  if (options.filterPortlessOutput) {
    pipeFilteredPortlessOutput(child);
  }
  return child;
}

export function spawnAndExit(command, env, managedChildren = [], options = {}) {
  const child = spawnChild(command[0], command.slice(1), env, {
    cwd: options.cwd,
    stdio: options.filterPortlessOutput
      ? ["inherit", "pipe", "pipe"]
      : "inherit",
    filterPortlessOutput: options.filterPortlessOutput,
  });
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
      process.exit(
        options.exitZeroOnSigint && signal === "SIGINT"
          ? 0
          : signalExitCode(signal),
      );
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
    if (error?.code === "ESRCH") return;
    if (error?.code === "EPERM") {
      try {
        child.kill(signal);
      } catch (fallbackError) {
        if (!["EPERM", "ESRCH"].includes(fallbackError?.code)) {
          throw fallbackError;
        }
      }
      return;
    }
    throw error;
  }
}

function signalExitCode(signal) {
  const codes = { SIGINT: 130, SIGTERM: 143 };
  return codes[signal] ?? 1;
}

function pipeFilteredPortlessOutput(child) {
  pipeFilteredLines(child.stdout, process.stdout);
  pipeFilteredLines(child.stderr, process.stderr);
}

function pipeFilteredLines(input, output) {
  if (!input) return;

  let pending = "";
  input.on("data", (chunk) => {
    pending += chunk.toString();
    const lines = pending.split(/\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!isPortlessBoilerplate(line)) output.write(`${line}\n`);
    }
  });
  input.on("end", () => {
    if (pending && !isPortlessBoilerplate(pending)) output.write(pending);
  });
}

function isPortlessBoilerplate(line) {
  const text = line.replace(/\r/g, "").trim();

  return (
    text === "" ||
    text === "portless" ||
    text === "-- Proxy is running" ||
    text.startsWith("-- Name ") ||
    text.startsWith("-- Using port ") ||
    (text.startsWith("-- ") && text.includes("(auto-resolves to 127.0.0.1)")) ||
    text.startsWith("-> https://") ||
    text.startsWith("Running: PORT=") ||
    text.startsWith("Killed existing process ")
  );
}
