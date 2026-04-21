import dns from "node:dns";
import { readFileSync } from "node:fs";
import https from "node:https";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const nextjsTarget = packageHyloDevUrl("../../examples/nextjs/package.json");
const cloudflareWorkerTarget = packageHyloDevUrl(
  "../../examples/cloudflare-worker/package.json",
);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    "import.meta.env.VITE_HYLO_WORKFLOW": JSON.stringify(
      process.env.HYLO_WORKFLOW ?? "",
    ),
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

function packageHyloDevUrl(packageJsonPath: string): string {
  const absolutePath = path.resolve(__dirname, packageJsonPath);
  const packageJson = JSON.parse(readFileSync(absolutePath, "utf8"));
  const devUrl = packageJson.hylo?.dev?.url;
  if (typeof devUrl === "string" && devUrl.trim()) {
    return devUrl.trim().replace(/\/$/, "");
  }
  throw new Error(`${absolutePath} must define hylo.dev.url`);
}
