import {
  createRemoteWorkflowQueue,
  createRemoteWorkflowStateStore,
} from "@workflow/remote";
import { createWorkflowServer } from "@workflow/server";
import "@/workflows";

type WorkflowApp = ReturnType<typeof createWorkflowServer>;

let workflowApp: WorkflowApp | undefined;

function getWorkflowApp(): WorkflowApp {
  if (workflowApp) return workflowApp;

  const remoteRuntimeUrl = runtimeBackendUrl();

  workflowApp = createWorkflowServer({
    basePath: "/api/workflow",
    stateStore: createRemoteWorkflowStateStore(remoteRuntimeUrl),
    queue: createRemoteWorkflowQueue(remoteRuntimeUrl),
    workflow: {
      id: "nextjs-example",
      version: "v1",
      name: "Next.js Example",
    },
  });

  return workflowApp;
}

function runtimeBackendUrl(): string {
  const raw = process.env.HYLO_BACKEND_URL?.trim();
  if (!raw) {
    throw new Error(
      "HYLO_BACKEND_URL is required. Start backend-node locally and set HYLO_BACKEND_URL=http://localhost:8787.",
    );
  }
  const baseUrl = raw.replace(/\/+$/, "");
  return baseUrl.endsWith("/runtime") ? baseUrl : `${baseUrl}/runtime`;
}

export function GET(request: Request): Response | Promise<Response> {
  return getWorkflowApp().fetch(request);
}

export function POST(request: Request): Response | Promise<Response> {
  return getWorkflowApp().fetch(request);
}

export const runtime = "nodejs";
