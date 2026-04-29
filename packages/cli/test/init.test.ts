import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runInit } from "../src/commands/init.js";

let previousCwd: string;
let previousHome: string | undefined;
let previousFlamecastLogDir: string | undefined;
let workspace: string;

beforeEach(async () => {
  previousCwd = process.cwd();
  previousHome = process.env.HOME;
  previousFlamecastLogDir = process.env.FLAMECAST_LOG_DIR;
  workspace = await mkdtemp(join(tmpdir(), "hylo-init-"));
  process.chdir(workspace);
  process.env.HOME = workspace;
  delete process.env.FLAMECAST_LOG_DIR;
  vi.restoreAllMocks();
});

afterEach(async () => {
  process.chdir(previousCwd);
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
  vi.restoreAllMocks();
  await rm(workspace, { force: true, recursive: true });
});

it("scaffolds the flamecast home structure and example worker", async () => {
  const stdout = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);

  await expect(runInit(["--no-empty-state-app"])).resolves.toBe(0);

  const flamecastEntries = await readdir(join(workspace, ".flamecast"));
  const rootGitignore = await readFile(
    join(workspace, ".flamecast", ".gitignore"),
    "utf8",
  );
  const packageJson = JSON.parse(
    await readFile(
      join(workspace, ".flamecast", "worker", "package.json"),
      "utf8",
    ),
  ) as {
    name: string;
    scripts: Record<string, string>;
    dependencies: Record<string, string>;
  };
  const source = await readFile(
    join(workspace, ".flamecast", "worker", "src", "index.ts"),
    "utf8",
  );
  const gmailSource = await readFile(
    join(workspace, ".flamecast", "worker", "src", "gmail.ts"),
    "utf8",
  );
  const linearSource = await readFile(
    join(workspace, ".flamecast", "worker", "src", "linear.ts"),
    "utf8",
  );
  const workerGitignore = await readFile(
    join(workspace, ".flamecast", "worker", ".gitignore"),
    "utf8",
  );

  expect(flamecastEntries).toEqual(
    expect.arrayContaining([
      ".gitignore",
      ".logs",
      ".raw",
      ".sessions",
      "worker",
    ]),
  );
  expect(rootGitignore).toBe(".logs\n.raw\n.sessions/\nflamecast.log\n");
  expect(packageJson.name).toBe("workflow-cloudflare-worker-example");
  expect(packageJson.scripts.dev).toBe("hylo dev .");
  expect(packageJson.dependencies["@workflow/integrations-gmail"]).toContain(
    "packages/integrations/gmail",
  );
  expect(packageJson.dependencies["@workflow/integrations-linear"]).toContain(
    "packages/integrations/linear",
  );
  expect(source).toContain("incidentAlert");
  expect(source).toContain('export * from "./gmail"');
  expect(source).toContain('export * from "./linear"');
  expect(gmailSource).toContain("gmailLastTenEmails");
  expect(linearSource).toContain("linearProjectsAndMyTickets");
  expect(workerGitignore).toBe(".hylo\n.wrangler\nnode_modules\n.env*\n");
  expect(stdout).toHaveBeenCalledWith(
    expect.stringContaining("Initialized Hylo example worker"),
  );
});

it("leaves an existing ~/.flamecast/worker alone without --force", async () => {
  const stdout = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);

  await expect(runInit(["--no-empty-state-app"])).resolves.toBe(0);
  await expect(runInit(["--no-empty-state-app"])).resolves.toBe(0);

  expect(stdout).toHaveBeenCalledWith(
    expect.stringContaining("leaving it alone"),
  );
});

it("skips an existing ~/.flamecast/worker directory without --force", async () => {
  const worker = join(workspace, ".flamecast", "worker");
  const stdout = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);

  await mkdir(worker, { recursive: true });

  await expect(runInit(["--no-empty-state-app"])).resolves.toBe(0);

  expect(stdout).toHaveBeenCalledWith(
    expect.stringContaining("leaving it alone"),
  );
});

it("replaces an existing ~/.flamecast/worker with --force", async () => {
  const worker = join(workspace, ".flamecast", "worker");
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);

  await mkdir(worker, { recursive: true });
  await writeFile(join(worker, "custom.txt"), "keep me");

  await expect(runInit(["--force", "--no-empty-state-app"])).resolves.toBe(0);

  await expect(access(join(worker, "custom.txt"))).rejects.toThrow();
  await expect(
    readFile(join(worker, "package.json"), "utf8"),
  ).resolves.toContain("workflow-cloudflare-worker-example");
});

it("uses FLAMECAST_LOG_DIR when provided", async () => {
  const root = join(workspace, "custom-flamecast");
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  process.env.FLAMECAST_LOG_DIR = root;

  await expect(runInit(["--no-empty-state-app"])).resolves.toBe(0);

  await expect(
    readFile(join(root, "worker", "package.json"), "utf8"),
  ).resolves.toContain("workflow-cloudflare-worker-example");
});
