import path from "node:path";
import type { HyloConfig } from "./config.js";

export interface WranglerConfig {
  name: string;
  main: string;
  compatibility_date: string;
  compatibility_flags?: string[];
  vars?: Record<string, string>;
  kv_namespaces?: Array<{ binding: string; id?: string }>;
  r2_buckets?: Array<{ binding: string; bucket_name?: string }>;
  d1_databases?: Array<{
    binding: string;
    database_name?: string;
    database_id?: string;
  }>;
}

const DEFAULT_COMPATIBILITY_DATE = "2026-04-19";
const DEFAULT_MAIN = "src/index.ts";

export function buildWranglerConfig(options: {
  hyloConfig: HyloConfig;
  projectRoot: string;
  outputDir: string;
}): WranglerConfig {
  const { hyloConfig, projectRoot, outputDir } = options;

  const mainAbs = path.resolve(projectRoot, hyloConfig.main ?? DEFAULT_MAIN);
  // Paths in wrangler.json are resolved relative to the config file,
  // which we write into outputDir.
  const main = path.relative(outputDir, mainAbs);

  const config: WranglerConfig = {
    name: hyloConfig.name,
    main,
    compatibility_date:
      hyloConfig.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE,
  };

  if (hyloConfig.compatibilityFlags?.length) {
    config.compatibility_flags = hyloConfig.compatibilityFlags;
  }
  if (hyloConfig.vars && Object.keys(hyloConfig.vars).length > 0) {
    config.vars = hyloConfig.vars;
  }
  if (hyloConfig.kvNamespaces?.length) {
    config.kv_namespaces = hyloConfig.kvNamespaces;
  }
  if (hyloConfig.r2Buckets?.length) {
    config.r2_buckets = hyloConfig.r2Buckets;
  }
  if (hyloConfig.d1Databases?.length) {
    config.d1_databases = hyloConfig.d1Databases;
  }

  return config;
}
