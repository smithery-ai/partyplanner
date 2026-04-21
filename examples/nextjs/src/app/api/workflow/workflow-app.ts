import { createOAuthHandoffRoutes } from "@workflow/integrations-oauth";
import { createWorkflow } from "@workflow/server";
import "@/workflows";

type WorkflowApp = ReturnType<typeof createWorkflow>;

let workflowApp: WorkflowApp | undefined;

export function getWorkflowApp(): WorkflowApp {
  if (workflowApp) return workflowApp;

  const backendApi = backendApiUrl();
  const app = createWorkflow({
    basePath: "/api/workflow",
    backendApi,
    workflow: {
      id: "nextjs-example",
      version: "v1",
      name: "Next.js Example",
    },
  });

  // Handoff routes for Hylo-curated OAuth connections (spotify, notion).
  // The broker (mounted on the backend) redirects browsers to these paths
  // with a one-time `handoff` code; the route exchanges it for the token
  // and resumes the workflow run.
  app.route(
    "/api/workflow/integrations",
    createOAuthHandoffRoutes({
      workflowApp: app,
      workflowBasePath: "/api/workflow",
      brokerBaseUrl: `${backendApi.replace(/\/+$/, "")}/oauth`,
      getAppToken: () => process.env.HYLO_API_KEY,
      providers: ["spotify", "notion"],
    }),
  );

  workflowApp = app;
  return workflowApp;
}

function backendApiUrl(): string {
  const raw = process.env.HYLO_BACKEND_URL?.trim();
  if (!raw) {
    throw new Error(
      "HYLO_BACKEND_URL is required. Start backend locally and set HYLO_BACKEND_URL=http://127.0.0.1:8788.",
    );
  }
  return raw;
}
