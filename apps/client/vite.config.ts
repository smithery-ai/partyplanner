import dns from "node:dns";
import https from "node:https";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const nextjsTarget =
  process.env.VITE_NEXTJS_WORKER_URL ??
  process.env.VITE_BACKEND_URL ??
  derivePortlessServiceUrl(process.env.PORTLESS_URL, "hylo", "nextjs.hylo") ??
  "http://localhost:3000";

const cloudflareWorkerTarget =
  process.env.VITE_CLOUDFLARE_WORKER_URL ??
  derivePortlessServiceUrl(
    process.env.PORTLESS_URL,
    "hylo",
    "cloudflare-worker.hylo",
  ) ??
  "http://localhost:8789";

const defaultWorkerTarget =
  process.env.VITE_WORKFLOW_WORKER === "cloudflare"
    ? cloudflareWorkerTarget
    : nextjsTarget;

const backendNodeUrl =
  process.env.VITE_BACKEND_NODE_URL ??
  derivePortlessServiceUrl(process.env.PORTLESS_URL, "hylo", "api.hylo") ??
  "http://localhost:8787";

const backendWorkerUrl =
  process.env.VITE_BACKEND_WORKER_URL ??
  derivePortlessServiceUrl(
    process.env.PORTLESS_URL,
    "hylo",
    "api-worker.hylo",
  ) ??
  "http://localhost:8788";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    "import.meta.env.VITE_RESOLVED_BACKEND_NODE_URL":
      JSON.stringify(backendNodeUrl),
    "import.meta.env.VITE_RESOLVED_BACKEND_WORKER_URL":
      JSON.stringify(backendWorkerUrl),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    proxy: {
      "/api/nextjs": workflowProxy(nextjsTarget, /^\/api\/nextjs(?=\/|$)/),
      "/api/cloudflare": workflowProxy(
        cloudflareWorkerTarget,
        /^\/api\/cloudflare(?=\/|$)/,
      ),
      "/api": workflowProxy(defaultWorkerTarget, /^\/api(?=\/|$)/),
    },
  },
});

function workflowProxy(target: string, prefix: RegExp) {
  return {
    target,
    changeOrigin: true,
    secure: false,
    agent: portlessLocalAgent(target),
    rewrite: (proxyPath: string) =>
      proxyPath.replace(prefix, "/api/workflow") || "/api/workflow",
  };
}

function derivePortlessServiceUrl(
  sourceUrl: string | undefined,
  sourceName: string,
  targetName: string,
): string | undefined {
  if (!sourceUrl) return undefined;

  try {
    const url = new URL(sourceUrl);
    const sourcePrefix = `${sourceName}.`;
    const sourceMarker = `.${sourceName}.`;

    if (url.hostname.startsWith(sourcePrefix)) {
      url.hostname = `${targetName}.${url.hostname.slice(sourcePrefix.length)}`;
      return url.origin;
    }

    const markerIndex = url.hostname.indexOf(sourceMarker);
    if (markerIndex === -1) return undefined;

    const prefix = url.hostname.slice(0, markerIndex);
    const suffix = url.hostname.slice(markerIndex + sourceMarker.length);
    url.hostname = `${prefix}.${targetName}.${suffix}`;
    return url.origin;
  } catch {
    return undefined;
  }
}

function portlessLocalAgent(target: string): https.Agent | undefined {
  try {
    const url = new URL(target);
    if (url.protocol !== "https:" || !url.hostname.endsWith(".local")) {
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
