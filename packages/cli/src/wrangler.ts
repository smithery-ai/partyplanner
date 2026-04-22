import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export function wranglerBin(): string {
  return require.resolve("wrangler/bin/wrangler.js");
}

export function runWrangler(args: string[], cwd: string): Promise<number> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(process.execPath, [wranglerBin(), ...args], {
      cwd,
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", rejectP);
    child.on("exit", (code) => resolveP(code ?? 1));
  });
}

export type WranglerCapturedResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export function runWranglerCaptured(
  args: string[],
  cwd: string,
): Promise<WranglerCapturedResult> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(process.execPath, [wranglerBin(), ...args], {
      cwd,
      stdio: ["inherit", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });

    child.on("error", rejectP);
    child.on("exit", (code) =>
      resolveP({ code: code ?? 1, stdout, stderr }),
    );
  });
}
