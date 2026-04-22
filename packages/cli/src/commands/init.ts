import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { info } from "../log.js";
import { scaffoldDir } from "../paths.js";

export async function runInit(args: string[]): Promise<number> {
  const force = args.includes("--force");
  const positional = args.filter((a) => !a.startsWith("--"));
  const targetArg = positional[0] ?? ".";
  const target = resolve(process.cwd(), targetArg);

  await mkdir(target, { recursive: true });
  const existing = await readdir(target).catch(() => []);
  if (existing.length > 0 && !force) {
    process.stderr.write(
      `Directory ${target} is not empty. Re-run with --force to overwrite.\n`,
    );
    return 1;
  }

  await cp(scaffoldDir, target, { recursive: true });

  const pkgPath = resolve(target, "package.json");
  const pkg = await readFile(pkgPath, "utf8");
  const name = sanitizeName(basename(target));
  await writeFile(pkgPath, pkg.replaceAll("{{name}}", name));

  info(`Created ${name} at ${target}`);
  info("");
  info("Next steps:");
  info(`  cd ${targetArg}`);
  info("  pnpm install");
  info("  pnpm hylo build");
  return 0;
}

function sanitizeName(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "hylo-workflow";
}
