import { Hono } from "hono";
import { z } from "zod";

// Signed OAuth state helpers and a generic Hono sub-app that forwards the
// OAuth redirect callback into the workflow intervention endpoint.

export type OAuthStatePayload = {
  runId: string;
  interventionId: string;
  [key: string]: string;
};

const signedStateSchema = z
  .object({
    runId: z.string(),
    interventionId: z.string(),
    signature: z.string(),
  })
  .catchall(z.string());

type HonoAppLike = {
  fetch(request: Request): Response | Promise<Response>;
};

export async function signOAuthState(
  payload: OAuthStatePayload,
  secret: string,
): Promise<string> {
  const signature = await hmacSign(canonicalize(payload), secret);
  return base64UrlEncodeUtf8(JSON.stringify({ ...payload, signature }));
}

export async function verifyOAuthState(
  encoded: string,
  secret: string,
): Promise<OAuthStatePayload> {
  const parsed = signedStateSchema.parse(
    JSON.parse(base64UrlDecodeUtf8(encoded)),
  );
  const { signature, ...payload } = parsed;
  const expected = await hmacSign(canonicalize(payload), secret);
  if (!constantTimeEqual(signature, expected)) {
    throw new Error("Invalid OAuth state signature.");
  }
  return payload as OAuthStatePayload;
}

export type OAuthCallbackRouteOptions = {
  // The parent workflow Hono app. Callback POSTs to the intervention endpoint
  // via the app's .fetch() so we do not need an external HTTP hop.
  workflowApp: HonoAppLike;
  // Base path of the workflow routes on the parent app.
  workflowBasePath?: string;
  // Accessor for the signing secret. Invoked per request so it can come from
  // a live env var, not captured at module load time.
  getStateSecret: () => string | undefined;
  // Titles for the success / error HTML responses shown to the user after the
  // OAuth redirect.
  successTitle?: string;
  successMessage?: string;
  errorTitle?: string;
};

// Returns a Hono sub-app with a GET /callback route. Mount with
// `app.route("/api/workflow/integrations/spotify", createOAuthCallbackRoute({ ... }))`.
export function createOAuthCallbackRoute(
  opts: OAuthCallbackRouteOptions,
): Hono {
  const app = new Hono();

  app.get("/callback", async (c) => {
    const url = new URL(c.req.url);
    const state = url.searchParams.get("state");
    if (!state) {
      return htmlResponse(
        opts.errorTitle ?? "Authorization failed",
        "Missing OAuth state.",
        400,
      );
    }

    const stateSecret = opts.getStateSecret();
    if (!stateSecret) {
      return htmlResponse(
        opts.errorTitle ?? "Authorization failed",
        "OAUTH_STATE_SECRET is required.",
        500,
      );
    }

    let target: OAuthStatePayload;
    try {
      target = await verifyOAuthState(state, stateSecret);
    } catch (e) {
      return htmlResponse(
        opts.errorTitle ?? "Authorization failed",
        errorMessage(e),
        400,
      );
    }

    const payload: Record<string, string> = {};
    for (const [key, value] of url.searchParams.entries()) {
      payload[key] = value;
    }

    const basePath = normalizeBasePath(
      opts.workflowBasePath ?? "/api/workflow",
    );
    const interventionUrl = new URL(
      `${basePath}/runs/${encodeURIComponent(
        target.runId,
      )}/interventions/${encodeURIComponent(target.interventionId)}`,
      url.origin,
    );

    const response = await opts.workflowApp.fetch(
      new Request(interventionUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payload, autoAdvance: true }),
      }),
    );

    if (!response.ok) {
      return htmlResponse(
        opts.errorTitle ?? "Authorization failed",
        await response.text(),
        response.status,
      );
    }

    return htmlResponse(
      opts.successTitle ?? "Connected",
      opts.successMessage ??
        "The workflow run has been resumed. You can return to the workflow tab.",
    );
  });

  return app;
}

function canonicalize(payload: OAuthStatePayload): string {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(payload).sort()) {
    sorted[key] = payload[key];
  }
  return JSON.stringify(sorted);
}

async function hmacSign(input: string, secret: string): Promise<string> {
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

function normalizeBasePath(basePath: string): string {
  if (!basePath || basePath === "/") return "";
  return `/${basePath.replace(/^\/+|\/+$/g, "")}`;
}

function base64UrlEncodeUtf8(value: string): string {
  return base64UrlEncodeBytes(new TextEncoder().encode(value));
}

function base64UrlDecodeUtf8(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(
    base64.length + ((4 - (base64.length % 4)) % 4),
    "=",
  );
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
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

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let i = 0; i < left.length; i += 1) {
    mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return mismatch === 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function htmlResponse(title: string, message: string, status = 200): Response {
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
