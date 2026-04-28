import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { flamecastRoot } from "../flamecast-root.js";
import { info } from "../log.js";
import { scaffoldDir } from "../paths.js";

const DEFAULT_EXAMPLE_WORKER_NAME = "workflow-cloudflare-worker-example";
const ROOT_GITIGNORE = [".logs", ".raw", ".sessions/", "flamecast.log"].join(
  "\n",
);
const ROOT_DIRECTORIES = [".logs", ".raw", ".sessions"];
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
      [
        "Usage: hylo init [--force]",
        "",
        "Creates ~/.flamecast with an example Hylo Worker at ~/.flamecast/worker.",
        "",
        "Options:",
        "  --force    Replace an existing ~/.flamecast/worker directory",
        "",
      ].join("\n"),
    );
    return 0;
  }

  const force = args.includes("--force");
  const unexpectedArgs = args.filter((arg) => arg !== "--force");
  if (unexpectedArgs.length > 0) {
    process.stderr.write(
      "hylo init only accepts --force. It initializes ~/.flamecast and writes the example worker to ~/.flamecast/worker.\n",
    );
    return 1;
  }

  const root = flamecastRoot();
  const target = resolve(root, "worker");
  const targetExists = await access(target)
    .then(() => true)
    .catch(() => false);
  if (targetExists && !force) {
    process.stderr.write(
      `Hylo example worker already exists at ${target}. Run hylo init --force to replace it.\n`,
    );
    return 1;
  }

  await ensureRoot(root);
  if (targetExists) {
    await rm(target, { force: true, recursive: true });
  }
  await cp(scaffoldDir, target, {
    force: false,
    recursive: true,
  });
  const targetPackageJson = resolve(target, "package.json");
  await writeFile(
    targetPackageJson,
    await renderPackageJson(target, targetPackageJson),
  );
  info(`Initialized Hylo example worker at ${target}`);
  info(`Run it locally with: hylo dev ~/.flamecast/worker`);
  return 0;
}

async function ensureRoot(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await Promise.all(
    ROOT_DIRECTORIES.map((dir) =>
      mkdir(resolve(root, dir), { recursive: true }),
    ),
  );
  await writeFileIfMissing(resolve(root, ".gitignore"), `${ROOT_GITIGNORE}\n`);
}

async function writeFileIfMissing(
  path: string,
  contents: string,
): Promise<void> {
  await writeFile(path, contents, { flag: "wx" }).catch((err: unknown) => {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      err.code === "EEXIST"
    ) {
      return;
    }
    throw err;
  });
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
