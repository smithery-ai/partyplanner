import dns from "node:dns";
import https from "node:https";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const resolvedHyloBackendUrl = hyloBackendUrl();
if (isVercelBuild() && !resolvedHyloBackendUrl) {
  throw new Error(
    "Vercel client builds require VITE_HYLO_BACKEND_URL or VITE_HYLO_BACKEND_PREVIEW_URL_TEMPLATE.",
  );
}
const backendCloudflareTarget =
  resolvedHyloBackendUrl || "https://api-worker.hylo.localhost";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    "import.meta.env.VITE_HYLO_BACKEND_URL": JSON.stringify(
      resolvedHyloBackendUrl,
    ),
    "import.meta.env.VITE_HYLO_WORKFLOW": JSON.stringify(
      process.env.VITE_HYLO_WORKFLOW ?? process.env.HYLO_WORKFLOW ?? "",
    ),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    host: process.env.HOST ?? "127.0.0.1",
    port: process.env.PORT ? Number(process.env.PORT) : 5173,
    strictPort: Boolean(process.env.PORT),
    proxy: {
      "/api": {
        target: backendCloudflareTarget,
        changeOrigin: true,
        secure: false,
        agent: hyloLocalAgent(backendCloudflareTarget),
        rewrite: (path) => path.replace(/^\/api(?=\/|$)/, "") || "/",
      },
      "/worker": {
        target: backendCloudflareTarget,
        changeOrigin: true,
        secure: false,
        agent: hyloLocalAgent(backendCloudflareTarget),
        rewrite: (path) => path.replace(/^\/worker(?=\/|$)/, "/workers"),
      },
      "/user_management": {
        target: "https://api.workos.com",
        changeOrigin: true,
      },
    },
  },
});

function hyloLocalAgent(target: string): https.Agent | undefined {
  try {
    const url = new URL(target);
    if (
      url.protocol !== "https:" ||
      (!url.hostname.endsWith(".local") && !url.hostname.endsWith(".localhost"))
    ) {
      return undefined;
    }
    return new https.Agent({
      lookup(hostname, optionsOrCallback, maybeCallback) {
        const callback =
          typeof optionsOrCallback === "function"
            ? optionsOrCallback
            : maybeCallback;
        if (!callback) return;
        if (hostname === url.hostname) {
          if (
            typeof optionsOrCallback === "object" &&
            optionsOrCallback !== null &&
            "all" in optionsOrCallback &&
            optionsOrCallback.all === true
          ) {
            callback(null, [{ address: "127.0.0.1", family: 4 }]);
            return;
          }
          callback(null, "127.0.0.1", 4);
          return;
        }
        if (typeof optionsOrCallback === "function") {
          dns.lookup(hostname, callback);
          return;
        }
        dns.lookup(hostname, optionsOrCallback, callback);
      },
    });
  } catch {
    return undefined;
  }
}

function hyloBackendUrl(): string {
  return (explicitHyloBackendUrl() ?? previewHyloBackendUrl() ?? "").replace(
    /\/+$/,
    "",
  );
}

function explicitHyloBackendUrl(): string | undefined {
  return firstEnv(["VITE_HYLO_BACKEND_URL", "HYLO_BACKEND_URL"]);
}

function previewHyloBackendUrl(): string | undefined {
  const template = firstEnv([
    "VITE_HYLO_BACKEND_PREVIEW_URL_TEMPLATE",
    "HYLO_BACKEND_PREVIEW_URL_TEMPLATE",
  ]);
  const branch = firstEnv([
    "VITE_VERCEL_GIT_COMMIT_REF",
    "VERCEL_GIT_COMMIT_REF",
    "GITHUB_HEAD_REF",
  ]);
  if (!template || !branch) return undefined;
  return template.replaceAll("{branch}", previewAlias(branch));
}

function isVercelBuild(): boolean {
  return process.env.VERCEL === "1" || Boolean(process.env.VERCEL_ENV);
}

function firstEnv(names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function previewAlias(branch: string): string {
  const normalized = branch
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return normalized || "preview";
}
