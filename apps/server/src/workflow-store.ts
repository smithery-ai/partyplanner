import { readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const workflowsDir = path.resolve(__dirname, "../../client/src/workflows")

export async function listWorkflowFiles(): Promise<string[]> {
  const entries = await readdir(workflowsDir)
  return entries
    .filter((f) => f.endsWith(".ts") && f !== "loader.ts")
    .sort()
}

export async function getWorkflowCode(filename: string): Promise<string> {
  validateFilename(filename)
  const filePath = path.join(workflowsDir, filename)
  return readFile(filePath, "utf8")
}

export async function updateWorkflowCode(
  filename: string,
  code: string,
): Promise<void> {
  validateFilename(filename)
  const filePath = path.join(workflowsDir, filename)
  await writeFile(filePath, code, "utf8")
}

function validateFilename(filename: string): void {
  if (
    !filename.endsWith(".ts") ||
    filename.includes("/") ||
    filename.includes("..") ||
    filename === "loader.ts"
  ) {
    throw new Error(`Invalid workflow filename: ${filename}`)
  }
}
