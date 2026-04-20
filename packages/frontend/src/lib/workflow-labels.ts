import type { WorkflowInputManifest } from "../types";

export function workflowInputLabel(
  input: Pick<WorkflowInputManifest, "id" | "title"> | undefined,
  fallbackId?: string,
): string {
  if (input?.title) return input.title;
  const id = input?.id ?? fallbackId;
  return id ? humanizeIdentifier(id) : "Workflow run";
}

function humanizeIdentifier(id: string): string {
  const spaced = id
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  if (!spaced) return id;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}
