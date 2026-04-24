import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";

const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx"]);
const SECRET_DECLARATION = /\bsecret\s*\(\s*["']([A-Z][A-Z0-9_]*)["']/g;

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

async function declaredSecretNames(srcDir: string): Promise<string[]> {
  const names = new Set<string>();
  for (const file of await sourceFiles(srcDir)) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(SECRET_DECLARATION)) {
      names.add(match[1]);
    }
  }
  return [...names].sort();
}

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
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
