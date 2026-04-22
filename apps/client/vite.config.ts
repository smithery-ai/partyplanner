import dns from "node:dns";
import { readFileSync } from "node:fs";
import https from "node:https";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const hyloConfig = readHyloConfig();
const nextjsTarget = targetUrl("workflow.nextjs");
const cloudflareWorkerTarget = targetUrl("workflow.cloudflareWorker");

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
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

function readHyloConfig() {
  return JSON.parse(
    readFileSync(path.resolve(__dirname, "../../hylo.json"), "utf8"),
  );
}

function targetUrl(target: string): string {
  const devUrl = hyloConfig.targets?.[target]?.url;
  if (typeof devUrl === "string" && devUrl.trim()) {
    return devUrl.trim().replace(/\/$/, "");
  }
  throw new Error(`hylo.json must define targets.${target}.url`);
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
