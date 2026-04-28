import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

const ROOT = process.env.FLAMECAST_LOG_DIR
  ? resolve(process.env.FLAMECAST_LOG_DIR)
  : resolve(homedir(), ".flamecast");

const MAX_ENTRIES = 5000;
const MAX_DEPTH = 8;

const ListFilesResponse = z
  .object({
    root: z.string(),
    paths: z.array(z.string()),
    truncated: z.boolean(),
  })
  .openapi("ListFilesResponse");

const ErrorResponse = z
  .object({ error: z.string() })
  .openapi("FilesErrorResponse");

const listFiles = createRoute({
  method: "get",
  path: "/files",
  tags: ["Files"],
  summary: "List files under the Flamecast data directory",
  responses: {
    200: {
      content: { "application/json": { schema: ListFilesResponse } },
      description: "Flat list of canonical relative paths",
    },
    500: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Server error",
    },
  },
});

async function walk(
  base: string,
  rel: string,
  depth: number,
  out: string[],
): Promise<boolean> {
  if (depth > MAX_DEPTH) return false;
  let entries: Dirent[];
  try {
    entries = await readdir(join(base, rel), { withFileTypes: true });
  } catch {
    return false;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isSymbolicLink()) continue;
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (await walk(base, childRel, depth + 1, out)) return true;
    } else if (entry.isFile()) {
      out.push(childRel);
      if (out.length >= MAX_ENTRIES) return true;
    }
  }
  return false;
}

export function fileRoutes() {
  const app = new OpenAPIHono();

  app.onError((err, c) => c.json({ error: err.message }, 500));

  return app.openapi(listFiles, async (c) => {
    const paths: string[] = [];
    const truncated = await walk(ROOT, "", 0, paths);
    return c.json({ root: ROOT, paths, truncated }, 200);
  });
}
