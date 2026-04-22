import "@workflow/frontend/styles.css";
import { createRoot } from "react-dom/client";
import { App } from "./App";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element not found");
}

createRoot(root).render(
  <App apiBaseUrl={import.meta.env.VITE_BACKEND_URL ?? "/api"} />,
);
