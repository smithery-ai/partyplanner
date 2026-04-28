import { access, cp, readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { info } from "../log.js";
import { scaffoldDir } from "../paths.js";

const DEFAULT_EXAMPLE_WORKER_NAME = "workflow-cloudflare-worker-example";
const WORKSPACE_DEPENDENCY_PATHS: Record<string, string> = {
  "@hylo/cli": "packages/cli",
  "@workflow/core": "packages/core",
  "@workflow/integrations-oauth": "packages/integrations/_oauth",
  "@workflow/runtime": "packages/runtime",
  "@workflow/server": "packages/server",
};

export async function runInit(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(
      "Usage: hylo init\n\nCreates ./.flamecast with an example Hylo Worker.\n",
    );
    return 0;
  }

  if (args.length > 0) {
    process.stderr.write(
      "hylo init does not accept arguments. It initializes ./.flamecast.\n",
    );
    return 1;
  }

  const target = resolve(process.cwd(), ".flamecast");
  const targetPackageJson = resolve(target, "package.json");
  const alreadyInitialized = await access(targetPackageJson)
    .then(() => true)
    .catch(() => false);
  if (alreadyInitialized) {
    process.stderr.write(`Hylo example worker already exists at ${target}\n`);
    return 1;
  }

  await cp(scaffoldDir, target, {
    force: false,
    recursive: true,
  });
  await writeFile(
    targetPackageJson,
    await renderPackageJson(target, targetPackageJson),
  );
  info(`Initialized Hylo example worker at ${target}`);
  info(`Run it locally with: hylo dev`);
  return 0;
}

async function renderPackageJson(
  target: string,
  packageJsonPath: string,
): Promise<string> {
  const raw = (await readFile(packageJsonPath, "utf8")).replaceAll(
    "{{name}}",
    DEFAULT_EXAMPLE_WORKER_NAME,
  );
  const pkg = JSON.parse(raw) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  for (const dependencies of [pkg.dependencies, pkg.devDependencies]) {
    if (!dependencies) continue;
    for (const [name, localPath] of Object.entries(
      WORKSPACE_DEPENDENCY_PATHS,
    )) {
      if (dependencies[name] !== "workspace:*") continue;
      const absoluteLocalPath = resolve(
        scaffoldDir,
        "..",
        "..",
        "..",
        "..",
        localPath,
      );
      const localPackageExists = await access(
        resolve(absoluteLocalPath, "package.json"),
      )
        .then(() => true)
        .catch(() => false);
      if (!localPackageExists) continue;
      dependencies[name] = `link:${relative(target, absoluteLocalPath)}`;
    }
  }

  return `${JSON.stringify(pkg, null, 2)}\n`;
}
