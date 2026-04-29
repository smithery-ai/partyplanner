import { access, readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";

const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx"]);
const SECRET_DECLARATION = /\bsecret\s*\(\s*["']([A-Z][A-Z0-9_]*)["']/g;
const BACKEND_MANAGED_SECRETS = new Set(["ARCADE_API_KEY"]);

export async function envSecretBindings(
  srcDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, unknown>[]> {
  const names = await declaredSecretNames(srcDir);
  return names.flatMap((name) => {
    const value = env[name]?.trim();
    return value ? [plainTextBinding(name, value)] : [];
  });
}

export async function envSecretWranglerVars(
  srcDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const names = await declaredSecretNames(srcDir);
  return names.flatMap((name) => {
    const value = env[name]?.trim();
    return value ? ["--var", `${name}:${value}`] : [];
  });
}

export async function declaredSecretNames(srcDir: string): Promise<string[]> {
  const names = new Set<string>();
  for (const root of await secretSourceRoots(srcDir)) {
    for (const file of await sourceFiles(root)) {
      const source = await readFile(file, "utf8");
      for (const match of source.matchAll(SECRET_DECLARATION)) {
        if (BACKEND_MANAGED_SECRETS.has(match[1])) continue;
        names.add(match[1]);
      }
    }
  }
  return [...names].sort();
}

async function secretSourceRoots(srcDir: string): Promise<string[]> {
  const projectRoot = dirname(srcDir);
  const roots = new Set<string>([srcDir]);
  const visited = new Set<string>();
  await addWorkflowDependencyRoots(projectRoot, roots, visited);
  return [...roots].sort();
}

async function addWorkflowDependencyRoots(
  projectRoot: string,
  roots: Set<string>,
  visited: Set<string>,
): Promise<void> {
  if (visited.has(projectRoot)) return;
  visited.add(projectRoot);

  const packageJson = await readPackageJson(
    resolve(projectRoot, "package.json"),
  );
  const dependencyNames = [
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.devDependencies ?? {}),
  ];
  for (const name of dependencyNames) {
    if (!name.startsWith("@workflow/")) continue;
    const packageRoot = await dependencyRoot(projectRoot, name);
    if (!packageRoot) continue;
    const sourceRoot = resolve(packageRoot, "src");
    if (await pathExists(sourceRoot)) roots.add(sourceRoot);
    await addWorkflowDependencyRoots(packageRoot, roots, visited);
  }
}

async function readPackageJson(path: string): Promise<{
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
  } catch {
    return {};
  }
}

async function dependencyRoot(
  projectRoot: string,
  packageName: string,
): Promise<string | undefined> {
  const direct = resolve(projectRoot, "node_modules", packageName);
  if (await pathExists(resolve(direct, "package.json"))) return direct;

  const packageJson = await readPackageJson(
    resolve(projectRoot, "package.json"),
  );
  const spec =
    packageJson.dependencies?.[packageName] ??
    packageJson.devDependencies?.[packageName];
  if (spec?.startsWith("link:")) {
    const linked = resolve(projectRoot, spec.slice("link:".length));
    if (await pathExists(resolve(linked, "package.json"))) return linked;
  }
  if (spec?.startsWith("file:")) {
    const linked = resolve(projectRoot, spec.slice("file:".length));
    if (await pathExists(resolve(linked, "package.json"))) return linked;
  }
  return undefined;
}

async function pathExists(path: string): Promise<boolean> {
  return access(path)
    .then(() => true)
    .catch(() => false);
}

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
        return [path];
      }
      return [];
    }),
  );
  return files.flat();
}

function plainTextBinding(name: string, text: string): Record<string, unknown> {
  return { name, text, type: "plain_text" };
}
