import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

export type ProjectInfo = {
  root: string;
  buildDir: string;
  buildSrcDir: string;
  workflowId: string;
  workflowName: string;
  workflowVersion: string;
  workerName: string;
};

const FORBIDDEN_FILES = [".env", ".dev.vars"];

export async function loadProject(cwd: string): Promise<ProjectInfo> {
  const root = cwd;
  const pkgPath = resolve(root, "package.json");
  const raw = await readFile(pkgPath, "utf8").catch(() => {
    throw new Error(`No package.json found at ${pkgPath}`);
  });
  const pkg = JSON.parse(raw) as { name?: string; version?: string };
  if (!pkg.name) throw new Error(`package.json is missing "name"`);

  const userEntry = resolve(root, "src", "index.ts");
  await access(userEntry).catch(() => {
    throw new Error(
      `Expected workflow entry at src/index.ts (got: ${userEntry})`,
    );
  });

  for (const file of FORBIDDEN_FILES) {
    const path = resolve(root, file);
    const present = await access(path)
      .then(() => true)
      .catch(() => false);
    if (present) throw forbiddenError(file);
  }

  const workerName = sanitizeWorkerName(pkg.name);
  return {
    root,
    buildDir: resolve(root, ".hylo", "build"),
    buildSrcDir: resolve(root, ".hylo", "build", "src"),
    workflowId: pkg.name,
    workflowName: pkg.name,
    workflowVersion: pkg.version || "v1",
    workerName,
  };
}

function forbiddenError(file: string): Error {
  switch (file) {
    case ".env":
    case ".dev.vars":
      return new Error(
        `${file} found in project root. Use the secret() primitive instead of ${file}.`,
      );
    default:
      return new Error(`${file} is not allowed in a Hylo project.`);
  }
}

function sanitizeWorkerName(raw: string): string {
  return (
    raw
      .replace(/^@[^/]+\//, "")
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "hylo-workflow"
  );
}
