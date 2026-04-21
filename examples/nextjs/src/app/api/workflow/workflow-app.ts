import { createOAuthHandoffRoutes } from "@workflow/integrations-oauth";
import { createWorkflow } from "@workflow/server";
import "@/workflows";

type WorkflowApp = ReturnType<typeof createWorkflow>;

const workflowApps = new Map<string, WorkflowApp>();

export function getWorkflowApp(request?: Request): WorkflowApp {
  const backendApi = backendApiUrl(request);
  const cached = workflowApps.get(backendApi);
  if (cached) return cached;

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

  workflowApps.set(backendApi, app);
  return app;
}

function backendApiUrl(request: Request | undefined): string {
  const raw =
    backendApiUrlFromRequest(request) ?? process.env.HYLO_BACKEND_URL?.trim();
  if (!raw) {
    throw new Error(
      "HYLO_BACKEND_URL is required, or pass backendUrl on the workflow request.",
    );
  }
  return raw;
}

function backendApiUrlFromRequest(
  request: Request | undefined,
): string | undefined {
  if (!request) return undefined;

  const url = new URL(request.url);
  const fromQuery =
    url.searchParams.get("backendUrl") ?? url.searchParams.get("backendApi");
  const fromHeader = request.headers.get("x-hylo-backend-url");

  return [fromQuery, fromHeader]
    .map((value) => value?.trim())
    .find((value): value is string => Boolean(value));
}
