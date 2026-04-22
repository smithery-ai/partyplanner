import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";

export interface BackendSpawnConfig {
  /** Command + args to spawn the backend, e.g. ["pnpm", "exec", "tsx", "src/index.ts"]. */
  command: string[];
  /** Working directory for the spawn, relative to the project root. */
  cwd?: string;
  /** Port the backend will listen on. Passed through as PORT env var and used to build the URL. */
  port?: number;
  /** Extra env vars to pass to the backend process. */
  env?: Record<string, string>;
}

export interface HyloConfig {
  name: string;
  main?: string;
  compatibilityDate?: string;
  compatibilityFlags?: string[];
  vars?: Record<string, string>;
  dispatchNamespace?: string;
  backend?: BackendSpawnConfig;
  kvNamespaces?: Array<{ binding: string; id?: string }>;
  r2Buckets?: Array<{ binding: string; bucket_name?: string }>;
  d1Databases?: Array<{
    binding: string;
    database_name?: string;
    database_id?: string;
  }>;
}

export function defineConfig(config: HyloConfig): HyloConfig {
  return config;
}

const CONFIG_FILES = [
  "hylo.config.ts",
  "hylo.config.mts",
  "hylo.config.js",
  "hylo.config.mjs",
];

export async function loadConfig(
  cwd: string,
): Promise<{ config: HyloConfig; configPath: string }> {
  const match = CONFIG_FILES.map((name) => path.join(cwd, name)).find((p) =>
    existsSync(p),
  );
  if (!match) {
    throw new Error(
      `No hylo.config.(ts|js) found in ${cwd}. Did you run \`workflow init\`?`,
    );
  }
  const jiti = createJiti(import.meta.url, { interopDefault: true });
  const loaded = (await jiti.import(pathToFileURL(match).href, {
    default: true,
  })) as HyloConfig;
  if (
    !loaded ||
    typeof loaded !== "object" ||
    typeof loaded.name !== "string"
  ) {
    throw new Error(
      `${path.basename(match)} must \`export default defineConfig({ name: ... })\`.`,
    );
  }
  return { config: loaded, configPath: match };
}
