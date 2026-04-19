import { RouterProvider } from "@tanstack/react-router";
import { WorkflowFrontendRoot } from "@workflow/frontend";
import "@workflow/frontend/styles.css";
import { createRoot } from "react-dom/client";
import { router } from "./router";
import workflowRaw from "./workflow.ts?raw";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element not found");
}

createRoot(root).render(
  <WorkflowFrontendRoot
    config={{
      apiBaseUrl: import.meta.env.VITE_BACKEND_URL ?? "/api",
      apiMode: "multi",
      defaultWorkflow: {
        source: workflowRaw,
        workflowId: "default",
        name: "Onboarding demo",
      },
    }}
  >
    <RouterProvider router={router} />
  </WorkflowFrontendRoot>,
);
