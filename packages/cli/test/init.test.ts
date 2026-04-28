import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runInit } from "../src/commands/init.js";

let previousCwd: string;
let workspace: string;

beforeEach(async () => {
  previousCwd = process.cwd();
  workspace = await mkdtemp(join(tmpdir(), "hylo-init-"));
  process.chdir(workspace);
  vi.restoreAllMocks();
});

afterEach(async () => {
  process.chdir(previousCwd);
  vi.restoreAllMocks();
  await rm(workspace, { force: true, recursive: true });
});

it("scaffolds the example worker in .flamecast", async () => {
  const stdout = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);

  await expect(runInit([])).resolves.toBe(0);

  const packageJson = JSON.parse(
    await readFile(join(workspace, ".flamecast", "package.json"), "utf8"),
  ) as { name: string; scripts: Record<string, string> };
  const source = await readFile(
    join(workspace, ".flamecast", "src", "index.ts"),
    "utf8",
  );

  expect(packageJson.name).toBe("workflow-cloudflare-worker-example");
  expect(packageJson.scripts.dev).toBe("hylo dev .");
  expect(source).toContain("incidentAlert");
  expect(stdout).toHaveBeenCalledWith(
    expect.stringContaining("Initialized Hylo example worker"),
  );
});

it("does not overwrite an existing .flamecast worker", async () => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(() => true);

  await expect(runInit([])).resolves.toBe(0);
  await expect(runInit([])).resolves.toBe(1);

  expect(stderr).toHaveBeenCalledWith(
    expect.stringContaining("Hylo example worker already exists"),
  );
});
