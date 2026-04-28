import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { defaultProjectRoot } from "../src/project.js";

let previousHome: string | undefined;
let previousFlamecastLogDir: string | undefined;
let workspace: string;

beforeEach(async () => {
  previousHome = process.env.HOME;
  previousFlamecastLogDir = process.env.FLAMECAST_LOG_DIR;
  workspace = await mkdtemp(join(tmpdir(), "hylo-dev-"));
  process.env.HOME = workspace;
  delete process.env.FLAMECAST_LOG_DIR;
});

afterEach(async () => {
  if (previousHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHome;
  }
  if (previousFlamecastLogDir === undefined) {
    delete process.env.FLAMECAST_LOG_DIR;
  } else {
    process.env.FLAMECAST_LOG_DIR = previousFlamecastLogDir;
  }
  await rm(workspace, { force: true, recursive: true });
});

it("uses the current directory when it is a worker project", async () => {
  const project = join(workspace, "worker-project");
  await mkdir(join(project, "src"), { recursive: true });
  await writeFile(join(project, "package.json"), "{}");
  await writeFile(join(project, "src", "index.ts"), "");

  await expect(defaultProjectRoot(project)).resolves.toBe(project);
});

it("defaults to ~/.flamecast/worker outside a worker project", async () => {
  const cwd = join(workspace, "not-a-worker");
  await mkdir(cwd, { recursive: true });

  await expect(defaultProjectRoot(cwd)).resolves.toBe(
    join(workspace, ".flamecast", "worker"),
  );
});

it("defaults to FLAMECAST_LOG_DIR/worker when configured", async () => {
  const cwd = join(workspace, "not-a-worker");
  const root = join(workspace, "custom-flamecast");
  await mkdir(cwd, { recursive: true });
  process.env.FLAMECAST_LOG_DIR = root;

  await expect(defaultProjectRoot(cwd)).resolves.toBe(join(root, "worker"));
});
