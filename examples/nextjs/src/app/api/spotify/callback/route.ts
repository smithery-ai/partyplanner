import {
  readSpotifyOAuthState,
  spotifyOauthStateSecretValue,
} from "@/workflows/spotify";
import { getWorkflowApp } from "../../workflow/workflow-app";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code") ?? undefined;
  const error = url.searchParams.get("error") ?? undefined;

  if (!state) {
    return htmlResponse("Spotify OAuth failed", "Missing OAuth state.", 400);
  }

  const stateSecret = spotifyOauthStateSecretValue();
  if (!stateSecret) {
    return htmlResponse(
      "Spotify OAuth failed",
      "OAUTH_STATE_SECRET is required in production.",
      500,
    );
  }

  let target: Awaited<ReturnType<typeof readSpotifyOAuthState>>;
  try {
    target = await readSpotifyOAuthState(state, stateSecret);
  } catch (e) {
    return htmlResponse("Spotify OAuth failed", errorMessage(e), 400);
  }

  const workflowUrl = new URL(
    `/api/workflow/runs/${encodeURIComponent(
      target.runId,
    )}/interventions/${encodeURIComponent(target.interventionId)}`,
    url.origin,
  );
  const response = await getWorkflowApp(request).fetch(
    new Request(workflowUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        payload: {
          code,
          state,
          error,
        },
        autoAdvance: true,
      }),
    }),
  );

  if (!response.ok) {
    return htmlResponse(
      "Spotify OAuth failed",
      await response.text(),
      response.status,
    );
  }

  return htmlResponse(
    "Spotify connected",
    "The workflow run has been resumed. You can return to the workflow tab.",
  );
}

export const runtime = "nodejs";

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
