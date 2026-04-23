const HYPHENATED_UUID =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const COMPACT_UUID = /[0-9a-f]{32}/i;

export type NotionParent =
  | { page_id: string }
  | { database_id: string }
  | { data_source_id: string };

export function normalizeNotionId(value: string, label = "Notion ID"): string {
  const trimmed = value.trim();
  const source = notionIdSource(trimmed);
  const hyphenated = source.match(HYPHENATED_UUID)?.[0];
  if (hyphenated) return hyphenated.toLowerCase();

  const compact = source.match(COMPACT_UUID)?.[0];
  if (compact) return hyphenateUuid(compact.toLowerCase());

  throw new Error(
    `${label} must be a Notion UUID, compact page ID, page URL, or page slug.`,
  );
}

export function normalizeNotionParent(value: string): NotionParent {
  const id = normalizeNotionId(value, "Notion parent ID");
  const type = explicitParentType(value) ?? parentTypeFromUrl(value);
  if (type === "database") return { database_id: id };
  if (type === "data_source") return { data_source_id: id };
  return { page_id: id };
}

function notionIdSource(value: string): string {
  const explicit = value.match(/^(page|database|data_source):(.+)$/i);
  if (explicit) return explicit[2].trim();

  try {
    const url = new URL(value);
    const segments = url.pathname.split("/").filter(Boolean);
    return decodeURIComponent(segments.at(-1) ?? value);
  } catch {
    return value;
  }
}

function hyphenateUuid(value: string): string {
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function explicitParentType(
  value: string,
): "page" | "database" | "data_source" | undefined {
  const match = value.trim().match(/^(page|database|data_source):/i);
  return match?.[1].toLowerCase() as
    | "page"
    | "database"
    | "data_source"
    | undefined;
}

function parentTypeFromUrl(value: string): "database" | undefined {
  try {
    const url = new URL(value);
    return url.searchParams.has("v") ? "database" : undefined;
  } catch {
    return undefined;
  }
}
