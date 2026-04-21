import { WorkflowSinglePage } from "@workflow/frontend";
import "@workflow/frontend/styles.css";
import { createRoot } from "react-dom/client";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element not found");
}

createRoot(root).render(
  <WorkflowSinglePage apiBaseUrl={resolveBackendUrl()} />,
);

function resolveBackendUrl(): string {
  const fromQuery = new URLSearchParams(window.location.search)
    .get("backendUrl")
    ?.trim();
  if (fromQuery) return fromQuery;

  const fromEnv = import.meta.env.VITE_BACKEND_URL?.trim();
  if (fromEnv) return fromEnv;

  throw new Error(
    "Backend URL is required. Pass it as ?backendUrl=... in the page URL, or set VITE_BACKEND_URL in the client environment.",
  );
}
