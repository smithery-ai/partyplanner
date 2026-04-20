import { WorkflowSinglePage } from "@workflow/frontend";
import "@workflow/frontend/styles.css";
import { createRoot } from "react-dom/client";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element not found");
}

createRoot(root).render(
  <WorkflowSinglePage
    apiBaseUrl={import.meta.env.VITE_BACKEND_URL ?? "/api"}
  />,
);
