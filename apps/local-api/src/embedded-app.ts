import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

interface Manifest {
  command: string;
  args?: string[];
  cwd?: string;
  port: number;
  url?: string;
  env?: Record<string, string>;
}

export interface EmbeddedApp {
  url: string | null;
  stop: () => Promise<void>;
}

function flamecastRoot(): string {
  const explicit = process.env.FLAMECAST_LOG_DIR?.trim();
  return explicit ? resolve(explicit) : resolve(homedir(), ".flamecast");
}

function readManifest(manifestPath: string): Manifest | null {
  try {
    const raw = readFileSync(manifestPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<Manifest>;
    if (
      typeof parsed.command !== "string" ||
      typeof parsed.port !== "number" ||
      !Number.isInteger(parsed.port) ||
      parsed.port <= 0 ||
      parsed.port > 65535
    ) {
      console.warn(
        `[embedded-app] manifest at ${manifestPath} is missing required fields { command, port }`,
      );
      return null;
    }
    return {
      command: parsed.command,
      args: Array.isArray(parsed.args) ? parsed.args : [],
      cwd: typeof parsed.cwd === "string" ? parsed.cwd : undefined,
      port: parsed.port,
      url: typeof parsed.url === "string" ? parsed.url : undefined,
      env:
        parsed.env && typeof parsed.env === "object"
          ? (parsed.env as Record<string, string>)
          : undefined,
    };
  } catch (err) {
    console.warn(`[embedded-app] failed to read manifest:`, err);
    return null;
  }
}

function pipeLogs(child: ChildProcess): void {
  const prefix = "[empty-state-app]";
  const forward = (
    stream: NodeJS.ReadableStream | null,
    target: "out" | "err",
  ) => {
    if (!stream) return;
    let buffer = "";
    stream.setEncoding("utf-8");
    stream.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const sink = target === "out" ? console.log : console.error;
        sink(`${prefix} ${line}`);
      }
    });
    stream.on("end", () => {
      if (buffer.length > 0) {
        const sink = target === "out" ? console.log : console.error;
        sink(`${prefix} ${buffer}`);
      }
    });
  };
  forward(child.stdout, "out");
  forward(child.stderr, "err");
}

export function startEmbeddedApp(): EmbeddedApp {
  const appDir = resolve(flamecastRoot(), "empty-state-app");
  const manifestPath = resolve(appDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    console.log(
      `[embedded-app] no manifest at ${manifestPath}; not starting an embedded app. Run "hylo init" to scaffold one.`,
    );
    return { url: null, stop: async () => {} };
  }

  const manifest = readManifest(manifestPath);
  if (!manifest) {
    return { url: null, stop: async () => {} };
  }

  const manifestDir = dirname(manifestPath);
  const cwd = manifest.cwd ? resolve(manifestDir, manifest.cwd) : manifestDir;
  if (!existsSync(cwd)) {
    console.warn(
      `[embedded-app] manifest cwd ${cwd} does not exist; skipping spawn. Re-run "hylo init --force" to re-scaffold.`,
    );
    return { url: null, stop: async () => {} };
  }
  console.log(
    `[embedded-app] spawning ${manifest.command} ${(manifest.args ?? []).join(" ")} in ${cwd} on port ${manifest.port}`,
  );

  const child = spawn(manifest.command, manifest.args ?? [], {
    cwd,
    env: {
      ...process.env,
      ...(manifest.env ?? {}),
      PORT: String(manifest.port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  pipeLogs(child);

  child.on("exit", (code, signal) => {
    console.log(
      `[embedded-app] exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
    );
  });

  child.on("error", (err) => {
    console.error(`[embedded-app] spawn error:`, err);
  });

  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolveStop) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
        resolveStop();
      }, 5000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolveStop();
      });
    });
  };

  return {
    url: manifest.url ?? `http://127.0.0.1:${manifest.port}`,
    stop,
  };
}
