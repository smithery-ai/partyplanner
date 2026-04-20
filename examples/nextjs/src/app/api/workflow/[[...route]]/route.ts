import { createWorkflow } from "@workflow/server";
import "@/workflows";

type WorkflowApp = ReturnType<typeof createWorkflow>;

let workflowApp: WorkflowApp | undefined;

function getWorkflowApp(): WorkflowApp {
  if (workflowApp) return workflowApp;

  workflowApp = createWorkflow({
    basePath: "/api/workflow",
    backendApi: backendApiUrl(),
    workflow: {
      id: "nextjs-example",
      version: "v1",
      name: "Next.js Example",
    },
  });

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

export function GET(request: Request): Response | Promise<Response> {
  return getWorkflowApp().fetch(request);
}

export function POST(request: Request): Response | Promise<Response> {
  return getWorkflowApp().fetch(request);
}

export const runtime = "nodejs";
