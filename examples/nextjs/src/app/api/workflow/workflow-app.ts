import { createNotionRoutes } from "@workflow/integrations-notion";
import { createSpotifyRoutes } from "@workflow/integrations-spotify";
import { createWorkflow } from "@workflow/server";
import "@/workflows";

type WorkflowApp = ReturnType<typeof createWorkflow>;

let workflowApp: WorkflowApp | undefined;

export function getWorkflowApp(): WorkflowApp {
  if (workflowApp) return workflowApp;

  const app = createWorkflow({
    basePath: "/api/workflow",
    backendApi: backendApiUrl(),
    cors: true,
    workflow: {
      id: "nextjs-example",
      version: "v1",
      name: "Next.js Example",
    },
  });

  const getStateSecret = () => process.env.OAUTH_STATE_SECRET;
  app.route(
    "/api/workflow/integrations/spotify",
    createSpotifyRoutes({ workflowApp: app, getStateSecret }),
  );
  app.route(
    "/api/workflow/integrations/notion",
    createNotionRoutes({ workflowApp: app, getStateSecret }),
  );

  workflowApp = app;
  return workflowApp;
}

function backendApiUrl(): string {
  const raw = process.env.HYLO_BACKEND_URL?.trim();
  if (!raw) {
    throw new Error(
      "HYLO_BACKEND_URL is required. Start backend-node locally and set HYLO_BACKEND_URL=http://localhost:8787.",
    );
  }
  return raw;
}
