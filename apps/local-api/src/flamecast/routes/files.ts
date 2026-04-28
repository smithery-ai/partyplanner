import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

const ROOT = process.env.FLAMECAST_LOG_DIR
  ? resolve(process.env.FLAMECAST_LOG_DIR)
  : resolve(homedir(), ".flamecast");

const MAX_ENTRIES = 5000;
const MAX_DEPTH = 8;
const MAX_FILE_BYTES = 2_000_000;

const ListFilesResponse = z
  .object({
    root: z.string(),
    paths: z.array(z.string()),
    truncated: z.boolean(),
  })
  .openapi("ListFilesResponse");

const FileContentResponse = z
  .object({
    path: z.string(),
    size: z.number(),
    truncated: z.boolean(),
    binary: z.boolean(),
    content: z.string(),
  })
  .openapi("FileContentResponse");

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

const FileContentQuery = z.object({
  path: z.string().min(1).openapi({ example: "worker/README.md" }),
});

const getFileContent = createRoute({
  method: "get",
  path: "/files/content",
  tags: ["Files"],
  summary: "Read a single file under the Flamecast data directory",
  request: { query: FileContentQuery },
  responses: {
    200: {
      content: { "application/json": { schema: FileContentResponse } },
      description: "File content as UTF-8 text (truncated if too large)",
    },
    400: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Invalid path",
    },
    404: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "File not found",
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

function isPathSafe(rel: string): boolean {
  if (!rel) return false;
  const normalized = rel.replace(/\\/g, "/");
  if (normalized.startsWith("/")) return false;
  const segments = normalized.split("/");
  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === "..") return false;
    if (seg.startsWith(".")) return false;
  }
  const absolute = resolve(ROOT, normalized);
  const rootWithSep = ROOT.endsWith("/") ? ROOT : `${ROOT}/`;
  return absolute === ROOT || absolute.startsWith(rootWithSep);
}

function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 8000));
  for (const byte of sample) {
    if (byte === 0) return true;
  }
  return false;
}

export function fileRoutes() {
  const app = new OpenAPIHono();

  app.onError((err, c) => c.json({ error: err.message }, 500));

  return app
    .openapi(listFiles, async (c) => {
      const paths: string[] = [];
      const truncated = await walk(ROOT, "", 0, paths);
      return c.json({ root: ROOT, paths, truncated }, 200);
    })
    .openapi(getFileContent, async (c) => {
      const { path: rel } = c.req.valid("query");
      if (!isPathSafe(rel)) {
        return c.json({ error: "Invalid path" }, 400);
      }
      const absolute = join(ROOT, rel);
      const st = await stat(absolute).catch(() => null);
      if (!st) {
        return c.json({ error: "File not found" }, 404);
      }
      if (!st.isFile()) {
        return c.json({ error: "Not a file" }, 400);
      }
      const truncated = st.size > MAX_FILE_BYTES;
      const buf = await readFile(absolute);
      const slice = truncated ? buf.subarray(0, MAX_FILE_BYTES) : buf;
      const binary = looksBinary(slice);
      const content = binary ? "" : slice.toString("utf8");
      return c.json(
        {
          path: rel,
          size: st.size,
          truncated,
          binary,
          content,
        },
        200,
      );
    });
}
