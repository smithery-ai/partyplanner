import { createOAuthCallbackRoute } from "@workflow/integrations-oauth";
import type { Hono } from "hono";

type HonoAppLike = {
  fetch(request: Request): Response | Promise<Response>;
};

export type NotionRoutesOptions = {
  workflowApp: HonoAppLike;
  workflowBasePath?: string;
  getStateSecret: () => string | undefined;
};

export function createNotionRoutes(opts: NotionRoutesOptions): Hono {
  return createOAuthCallbackRoute({
    workflowApp: opts.workflowApp,
    workflowBasePath: opts.workflowBasePath,
    getStateSecret: opts.getStateSecret,
    successTitle: "Notion connected",
    successMessage:
      "The workflow run has been resumed. You can return to the workflow tab.",
    errorTitle: "Notion OAuth failed",
  });
}
