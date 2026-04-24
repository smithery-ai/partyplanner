import { Hono } from "hono";
import { z } from "zod";
import {
  base64UrlDecodeUtf8,
  base64UrlEncodeUtf8,
  constantTimeEqual,
  errorMessage,
  hmacSign,
  htmlResponse,
  normalizeBasePath,
} from "./internal";

// BYO OAuth flow — the workflow author supplies client_id/client_secret as
// `secret()` inputs and the integration package does the token exchange in
// the runtime. Use this when you don't want to run a broker.
//
// The brokered flow in `atom.ts` + `handoff.ts` is preferred when you don't
// want users to ever see client credentials.

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
        body: JSON.stringify({ payload }),
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
