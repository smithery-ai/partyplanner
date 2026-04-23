import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type BuildOptions, parseBuildArgs } from "../args.js";
import { info } from "../log.js";
import { workerShimPath } from "../paths.js";
import { loadProject, type ProjectInfo } from "../project.js";
import { runWrangler } from "../wrangler.js";

const COMPATIBILITY_DATE = "2026-04-19";

export async function runBuild(args: string[]): Promise<number> {
  const { options } = parseBuildArgs(args);
  const project = await loadProject(process.cwd());
  const bundle = await buildWorkerBundle(project, options);
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

export async function prepareBuildDir(
  project: ProjectInfo,
  options: BuildOptions = {},
): Promise<void> {
  await rm(project.buildDir, { recursive: true, force: true });
  await mkdir(project.buildSrcDir, { recursive: true });

  await copyFile(
    resolve(project.root, "src", "index.ts"),
    resolve(project.buildSrcDir, "user-workflow.ts"),
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
    ``,
    `[vars]`,
    ...vars,
    ``,
  ].join("\n");
}

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
