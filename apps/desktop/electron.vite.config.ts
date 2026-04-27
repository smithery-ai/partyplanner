import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

const resolvedBackendUrl = hyloBackendUrl();

export default defineConfig({
  main: {
    define: {
      "import.meta.env.MAIN_VITE_HYLO_BACKEND_URL":
        JSON.stringify(resolvedBackendUrl),
      "import.meta.env.MAIN_VITE_WORKOS_API_HOSTNAME": JSON.stringify(
        firstEnv([
          "MAIN_VITE_WORKOS_API_HOSTNAME",
          "VITE_WORKOS_API_HOSTNAME",
          "WORKOS_CLIENT_API_HOSTNAME",
          "WORKOS_API_HOSTNAME",
        ]) ?? "",
      ),
      "import.meta.env.MAIN_VITE_WORKOS_CLIENT_ID": JSON.stringify(
        firstEnv(["MAIN_VITE_WORKOS_CLIENT_ID", "VITE_WORKOS_CLIENT_ID"]) ?? "",
      ),
    },
  },
  preload: {},
  renderer: {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src/renderer/src"),
      },
    },
    build: {
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, "./src/renderer/index.html"),
        },
      },
    },
    define: {
      "import.meta.env.VITE_HYLO_BACKEND_URL":
        JSON.stringify(resolvedBackendUrl),
      "import.meta.env.VITE_HYLO_TENANT_ID": JSON.stringify(
        process.env.VITE_HYLO_TENANT_ID ?? "",
      ),
      "import.meta.env.VITE_HYLO_WORKFLOW": JSON.stringify(
        process.env.VITE_HYLO_WORKFLOW ?? process.env.HYLO_WORKFLOW ?? "",
      ),
      "import.meta.env.VITE_HYLO_WORKFLOW_REGISTRY_URL": JSON.stringify(
        process.env.VITE_HYLO_WORKFLOW_REGISTRY_URL ?? "",
      ),
    },
  },
});

function hyloBackendUrl(): string {
  return (
    firstEnv(["VITE_HYLO_BACKEND_URL", "HYLO_BACKEND_URL"]) ??
    "https://hylo-backend.smithery.workers.dev"
  ).replace(/\/+$/, "");
}

function firstEnv(names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}
