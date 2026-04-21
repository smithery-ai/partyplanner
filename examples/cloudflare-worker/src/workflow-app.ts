import { createWorkflow } from "@workflow/server";
import "./workflows";

type WorkflowApp = ReturnType<typeof createWorkflow>;

let workflowApp: WorkflowApp | undefined;

export function getWorkflowApp(options: {
  backendApiUrl: string | undefined;
}): WorkflowApp {
  if (workflowApp) return workflowApp;

  workflowApp = createWorkflow({
    basePath: "/api/workflow",
    backendApi: requireBackendApiUrl(options.backendApiUrl),
    cors: true,
    workflow: {
      id: "cloudflare-worker-example",
      version: "v1",
      name: "Cloudflare Worker Example",
    },
  });

  return workflowApp;
}

function requireBackendApiUrl(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(
      "HYLO_BACKEND_URL is required. Start backend-node locally and set HYLO_BACKEND_URL=http://localhost:8787, or expose it through wrangler.toml/.dev.vars.",
    );
  }
  return trimmed;
}
