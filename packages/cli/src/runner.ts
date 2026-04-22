import { type ChildProcess, spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

export function resolveWranglerBin(cwd: string): string {
  const userRequire = createRequire(path.join(cwd, "__resolve__.js"));
  try {
    return userRequire.resolve("wrangler/bin/wrangler.js");
  } catch {
    const ownRequire = createRequire(import.meta.url);
    return ownRequire.resolve("wrangler/bin/wrangler.js");
  }
}

export interface WranglerHandle {
  child: ChildProcess;
  exitCode: Promise<number>;
}

export function runWrangler(args: string[], cwd: string): WranglerHandle {
  const bin = resolveWranglerBin(cwd);
  const child = spawn(process.execPath, [bin, ...args], {
    cwd,
    stdio: "inherit",
    env: process.env,
  });
  const exitCode = new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) return resolve(1);
      resolve(code ?? 0);
    });
  });
  return { child, exitCode };
}
