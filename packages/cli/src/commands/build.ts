import { spawn } from "node:child_process";
import {
  access,
  copyFile,
  cp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { relative, resolve } from "node:path";
import { type BuildOptions, parseBuildArgs } from "../args.js";
import { resolveHyloBackendUrl } from "../config.js";
import { info } from "../log.js";
import { workerShimPath } from "../paths.js";
import {
  defaultProjectRoot,
  loadProject,
  type ProjectInfo,
} from "../project.js";
import { runWrangler } from "../wrangler.js";

const COMPATIBILITY_DATE = "2026-04-19";

export async function runBuild(args: string[]): Promise<number> {
  const { options, rest } = parseBuildArgs(args);
  if (rest.length > 1) {
    throw new Error(`Unexpected argument for build: ${rest[1]}`);
  }
  const projectRoot = rest[0]
    ? resolve(process.cwd(), rest[0])
    : await defaultProjectRoot(process.cwd());
  const project = await loadProject(projectRoot);
  const backendUrl = resolveHyloBackendUrl({ local: options.local });
  const bundle = await buildWorkerBundle(project, { ...options, backendUrl });
  info(`Built ${project.workerName} → ${bundle.outputDir}`);
  return 0;
}

export type WorkerBundle = {
  moduleCode: string;
  moduleName: string;
  modulePath: string;
  outputDir: string;
};

export async function buildWorkerBundle(
  project: ProjectInfo,
  options: BuildOptions = {},
): Promise<WorkerBundle> {
  await buildLinkedDependencies(project.root);
  await prepareBuildDir(project, options);
  const code = await runWrangler(
    ["deploy", "--dry-run", "--outdir", "dist"],
    project.buildDir,
  );
  if (code !== 0) {
    throw new Error(`Wrangler build failed with exit code ${code}.`);
  }

  const outputDir = resolve(project.buildDir, "dist");
  const modulePath = resolve(outputDir, "index.js");
  return {
    moduleCode: await readFile(modulePath, "utf8"),
    moduleName: "index.mjs",
    modulePath,
    outputDir,
  };
}

async function buildLinkedDependencies(
  projectRoot: string,
  seen = new Set<string>(),
): Promise<void> {
  const packageJsonPath = resolve(projectRoot, "package.json");
  const raw = await readFile(packageJsonPath, "utf8");
  const pkg = JSON.parse(raw) as {
    dependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };

  for (const [name, specifier] of Object.entries(pkg.dependencies ?? {})) {
    const dependencyRoot = await linkedDependencyRoot(
      projectRoot,
      name,
      specifier,
    );
    if (!dependencyRoot || seen.has(dependencyRoot)) continue;
    seen.add(dependencyRoot);

    await buildLinkedDependencies(dependencyRoot, seen);
    const dependencyPackageJson = JSON.parse(
      await readFile(resolve(dependencyRoot, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    if (!dependencyPackageJson.scripts?.build) continue;

    info(
      `Building linked dependency ${name} (${relative(projectRoot, dependencyRoot)})`,
    );
    const code = await runCommand("pnpm", ["--dir", dependencyRoot, "build"]);
    if (code !== 0) {
      throw new Error(
        `Build failed for linked dependency ${name} with exit code ${code}.`,
      );
    }
  }
}

async function linkedDependencyRoot(
  projectRoot: string,
  packageName: string,
  specifier: string,
): Promise<string | undefined> {
  const prefix = specifier.startsWith("link:")
    ? "link:"
    : specifier.startsWith("file:")
      ? "file:"
      : undefined;
  if (!prefix && specifier !== "workspace:*") return undefined;

  if (prefix) {
    const target = specifier.slice(prefix.length);
    if (!target || target.endsWith(".tgz")) return undefined;
    return resolve(projectRoot, target);
  }

  const nodeModulePath = resolve(projectRoot, "node_modules", packageName);
  const packageJsonPath = resolve(nodeModulePath, "package.json");
  const exists = await access(packageJsonPath)
    .then(() => true)
    .catch(() => false);
  if (!exists) return undefined;
  return realpath(nodeModulePath);
}

function runCommand(command: string, args: string[]): Promise<number> {
  return new Promise((resolveExit) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", (err) => {
      process.stderr.write(`Failed to launch ${command}: ${err.message}\n`);
      resolveExit(1);
    });
    child.on("exit", (code, signal) => {
      resolveExit(signal ? 1 : (code ?? 1));
    });
  });
}

export async function prepareBuildDir(
  project: ProjectInfo,
  options: BuildOptions = {},
): Promise<void> {
  await rm(project.buildDir, { recursive: true, force: true });
  await mkdir(project.buildSrcDir, { recursive: true });

  await cp(
    resolve(project.root, "src"),
    resolve(project.buildSrcDir, "user-workflow"),
    {
      recursive: true,
    },
  );
  await copyFile(workerShimPath, resolve(project.buildSrcDir, "index.ts"));
  await writeFile(
    resolve(project.buildDir, "wrangler.toml"),
    renderWranglerToml(project, options),
  );
}

function renderWranglerToml(
  project: ProjectInfo,
  options: BuildOptions,
): string {
  const vars = [
    `HYLO_WORKFLOW_ID = "${project.workflowId}"`,
    `HYLO_WORKFLOW_NAME = "${project.workflowName}"`,
    `HYLO_WORKFLOW_VERSION = "${project.workflowVersion}"`,
  ];
  if (options.backendUrl) {
    vars.push(`HYLO_BACKEND_URL = "${escapeTomlString(options.backendUrl)}"`);
  }
  return [
    `name = "${project.workerName}"`,
    `main = "src/index.ts"`,
    `compatibility_date = "${COMPATIBILITY_DATE}"`,
    `compatibility_flags = ["global_fetch_strictly_public"]`,
    ``,
    `[vars]`,
    ...vars,
    ``,
  ].join("\n");
}

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
