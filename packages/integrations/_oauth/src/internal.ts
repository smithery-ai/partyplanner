// Shared helpers for the OAuth integration package. Not part of the public API.

export function normalizeBasePath(basePath: string): string {
  if (!basePath || basePath === "/") return "";
  return `/${basePath.replace(/^\/+|\/+$/g, "")}`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function responsePreview(response: Response): Promise<string> {
  const text = await response.text();
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

export function htmlResponse(
  title: string,
  message: string,
  status = 200,
): Response {
  return new Response(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #18181b;
        background: #fafafa;
      }
      main {
        max-width: 36rem;
        padding: 2rem;
      }
      h1 {
        margin: 0 0 0.5rem;
        font-size: 1rem;
      }
      p {
        margin: 0;
        color: #52525b;
        font-size: 0.875rem;
        line-height: 1.5;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
    </main>
  </body>
</html>`,
    {
      status,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    },
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function hmacSign(input: string, secret: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Web Crypto is required to sign OAuth state.");
  }
  const encoder = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await globalThis.crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(input),
  );
  return base64UrlEncodeBytes(new Uint8Array(signature));
}

export function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let i = 0; i < left.length; i += 1) {
    mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return mismatch === 0;
}

export function base64UrlEncodeUtf8(value: string): string {
  return base64UrlEncodeBytes(new TextEncoder().encode(value));
}

export function base64UrlDecodeUtf8(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(
    base64.length + ((4 - (base64.length % 4)) % 4),
    "=",
  );
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
