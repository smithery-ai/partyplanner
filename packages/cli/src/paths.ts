import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const templatesDir = resolve(here, "..", "templates");
export const scaffoldDir = resolve(templatesDir, "scaffold");
export const workerShimPath = resolve(templatesDir, "worker-shim.ts");
