export function firstNonEmpty(...values: (string | undefined)[]): string {
  return values.map((value) => value?.trim()).find(Boolean) ?? "";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJsonArray(text: string): string[] {
  const parsed = safeJsonParse(text);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is string => typeof item === "string");
}

export function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
