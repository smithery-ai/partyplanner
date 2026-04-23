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
  resolvedHyloBackendUrl || localUrl(process.env.HYLO_BACKEND_PORT, 8787);
const nextjsTarget = envUrl(
  ["VITE_HYLO_NEXTJS_WORKFLOW_URL", "HYLO_NEXTJS_WORKFLOW_URL"],
  "http://127.0.0.1:3000",
);
const cloudflareWorkerTarget = envUrl(
  ["VITE_HYLO_CLOUDFLARE_WORKFLOW_URL", "HYLO_CLOUDFLARE_WORKFLOW_URL"],
  localUrl(process.env.HYLO_CLOUDFLARE_WORKER_PORT, 8788),
);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    "import.meta.env.VITE_HYLO_BACKEND_URL": JSON.stringify(
      resolvedHyloBackendUrl,
    ),
    "import.meta.env.VITE_HYLO_WORKFLOW": JSON.stringify(
      process.env.VITE_HYLO_WORKFLOW ?? process.env.HYLO_WORKFLOW ?? "",
    ),
    __HYLO_WORKFLOWS__: JSON.stringify(workflowRegistry()),
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
      "/api/nextjs": workflowProxy(nextjsTarget, /^\/api\/nextjs(?=\/|$)/),
      "/api/cloudflare": workflowProxy(
        cloudflareWorkerTarget,
        /^\/api\/cloudflare(?=\/|$)/,
      ),
      "/api": workflowProxy(nextjsTarget, /^\/api(?=\/|$)/),
      "/auth": {
        target: backendCloudflareTarget,
        changeOrigin: true,
        secure: false,
        agent: hyloLocalAgent(backendCloudflareTarget),
      },
      "/deployments": {
        target: backendCloudflareTarget,
        changeOrigin: true,
        secure: false,
        agent: hyloLocalAgent(backendCloudflareTarget),
      },
      "/tenants": {
        target: backendCloudflareTarget,
        changeOrigin: true,
        secure: false,
        agent: hyloLocalAgent(backendCloudflareTarget),
      },
      "/user_management": {
        target: "https://api.workos.com",
        changeOrigin: true,
      },
    },
  },
});

function workflowProxy(target: string, prefix: RegExp) {
  return {
    target,
    changeOrigin: true,
    secure: false,
    agent: hyloLocalAgent(target),
    rewrite: (proxyPath: string) =>
      proxyPath.replace(prefix, "/api/workflow") || "/api/workflow",
  };
}

function localUrl(portValue: string | undefined, fallbackPort: number) {
  const port = Number(portValue ?? fallbackPort);
  const resolvedPort =
    Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallbackPort;
  return `http://127.0.0.1:${resolvedPort}`;
}

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

function envUrl(names: string[], fallback: string): string {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value.replace(/\/+$/, "");
  }
  return fallback;
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

function workflowRegistry() {
  const raw =
    process.env.VITE_HYLO_WORKFLOWS ?? process.env.HYLO_WORKFLOWS ?? "";
  if (raw.trim()) {
    try {
      return normalizeWorkflowRegistry(JSON.parse(raw));
    } catch {
      throw new Error("HYLO_WORKFLOWS must be valid JSON");
    }
  }

  return {
    defaultWorkflow: "workflow.nextjs",
    workflows: {
      "workflow.nextjs": {
        label: "Next.js",
        url: "/api/nextjs",
      },
      "workflow.cloudflareWorker": {
        label: "Cloudflare Worker",
        url: "/api/cloudflare",
      },
    },
  };
}

function normalizeWorkflowRegistry(value: unknown) {
  if (!value || typeof value !== "object" || !("workflows" in value)) {
    throw new Error("HYLO_WORKFLOWS must define workflows");
  }

  const workflows = (value as { workflows?: unknown }).workflows;
  if (!workflows || typeof workflows !== "object") {
    throw new Error("HYLO_WORKFLOWS workflows must be an object");
  }

  const entries = Object.entries(workflows).map(([id, config]) => {
    if (!config || typeof config !== "object" || !("url" in config)) {
      throw new Error(`HYLO_WORKFLOWS ${id} must define url`);
    }
    const url = (config as { url?: unknown }).url;
    if (typeof url !== "string" || !url.trim()) {
      throw new Error(`HYLO_WORKFLOWS ${id}.url must be a string`);
    }
    const label = (config as { label?: unknown }).label;
    return [
      id,
      {
        ...(typeof label === "string" && label.trim() ? { label } : {}),
        url: url.trim(),
      },
    ];
  });
  if (entries.length === 0) {
    throw new Error("HYLO_WORKFLOWS must include at least one workflow");
  }

  const defaultWorkflow = (value as { defaultWorkflow?: unknown })
    .defaultWorkflow;
  return {
    defaultWorkflow:
      typeof defaultWorkflow === "string" &&
      entries.some(([id]) => id === defaultWorkflow)
        ? defaultWorkflow
        : entries[0][0],
    workflows: Object.fromEntries(entries),
  };
}
