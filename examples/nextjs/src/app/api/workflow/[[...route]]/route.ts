import { PGlite } from "@electric-sql/pglite";
import {
  createPostgresWorkflowQueue,
  createPostgresWorkflowStateStore,
} from "@workflow/postgres";
import { createWorkflowServer } from "@workflow/server";
import { drizzle } from "drizzle-orm/pglite";
import * as workflows from "@/workflows";

type WorkflowApp = ReturnType<typeof createWorkflowServer>;

let workflowApp: WorkflowApp | undefined;

function getWorkflowApp(): WorkflowApp {
  if (workflowApp) return workflowApp;

  const dataDir = process.env.WORKFLOW_PGLITE_DATA_DIR ?? "./.workflow-data";
  const client = new PGlite(dataDir);
  const db = drizzle({ client });

  workflowApp = createWorkflowServer({
    basePath: "/api/workflow",
    workflows,
    stateStore: createPostgresWorkflowStateStore(db),
    queue: createPostgresWorkflowQueue(db),
    workflow: {
      id: "nextjs-example",
      version: "v1",
      name: "Next.js Example",
    },
  });

  return workflowApp;
}

export function GET(request: Request): Response | Promise<Response> {
  return getWorkflowApp().fetch(request);
}

export function POST(request: Request): Response | Promise<Response> {
  return getWorkflowApp().fetch(request);
}

export const runtime = "nodejs";
