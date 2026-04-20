declare global {
  var __workflowExampleSecrets: Record<string, string> | undefined;
}

export function exampleSecretValue(
  name: string,
  value: string | undefined,
): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (process.env.NODE_ENV === "production") return undefined;

  globalThis.__workflowExampleSecrets ??= {};
  const cache = globalThis.__workflowExampleSecrets;
  cache[name] ??= `dev-${name.toLowerCase()}-${randomId()}`;
  return cache[name];
}

function randomId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)
  );
}
