import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

export const templatesDir = resolve(here, "..", "templates");
export const scaffoldDir = resolve(templatesDir, "scaffold");
export const workerShimPath = resolve(templatesDir, "worker-shim.ts");
