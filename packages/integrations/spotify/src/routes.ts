import { createOAuthCallbackRoute } from "@workflow/integrations-oauth";
import type { Hono } from "hono";

type HonoAppLike = {
  fetch(request: Request): Response | Promise<Response>;
};

export type SpotifyRoutesOptions = {
  workflowApp: HonoAppLike;
  workflowBasePath?: string;
  getStateSecret: () => string | undefined;
};

// Hono sub-app with the Spotify OAuth callback route. Mount it on the parent
// app with `app.route("/api/workflow/integrations/spotify", createSpotifyRoutes({ ... }))`.
export function createSpotifyRoutes(opts: SpotifyRoutesOptions): Hono {
  return createOAuthCallbackRoute({
    workflowApp: opts.workflowApp,
    workflowBasePath: opts.workflowBasePath,
    getStateSecret: opts.getStateSecret,
    successTitle: "Spotify connected",
    successMessage:
      "The workflow run has been resumed. You can return to the workflow tab.",
    errorTitle: "Spotify OAuth failed",
  });
}
