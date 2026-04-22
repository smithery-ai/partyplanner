import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { log } from "../log.js";
import { templatesDir } from "../paths.js";

const RENAME_MAP: Record<string, string> = {
  _gitignore: ".gitignore",
  _package: "package.json",
  _package_json: "package.json",
  "_package.json": "package.json",
  "_env.example": ".env.example",
};

export async function init(argv: string[]): Promise<number> {
  const name = argv[0];
  if (!name || name.startsWith("-")) {
    log.error("Usage: workflow init <project-name>");
    return 1;
  }
  if (!/^[a-z0-9][a-z0-9-_]*$/i.test(name)) {
    log.error(
      "Project name must start with a letter or number and contain only letters, numbers, dashes, and underscores.",
    );
    return 1;
  }

  const targetDir = path.resolve(process.cwd(), name);
  if (await directoryHasFiles(targetDir)) {
    log.error(`Directory ${targetDir} is not empty.`);
    return 1;
  }

  await mkdir(targetDir, { recursive: true });
  const templateRoot = path.join(templatesDir(), "default");
  await copyTemplate(templateRoot, targetDir, name);

  log.success(`Created ${name}`);
  log.info("");
  log.dim("Next steps:");
  log.info(`  cd ${name}`);
  log.info(`  pnpm install   # or npm / yarn / bun`);
  log.info("  pnpm dev");
  return 0;
}

async function directoryHasFiles(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir);
    return entries.length > 0;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

async function copyTemplate(
  src: string,
  dest: string,
  appName: string,
): Promise<void> {
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const renamed = RENAME_MAP[entry.name] ?? entry.name;
    const destPath = path.join(dest, renamed);
    if (entry.isDirectory()) {
      await mkdir(destPath, { recursive: true });
      await copyTemplate(srcPath, destPath, appName);
    } else {
      const contents = await readFile(srcPath, "utf8");
      await writeFile(destPath, contents.replaceAll("__APP_NAME__", appName));
    }
  }
}
