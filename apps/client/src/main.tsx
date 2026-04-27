import {
  HyloClientShell,
  type HyloClientShellSearch,
  type HyloWorkflowRegistry,
  type HyloWorkflowRegistryConfig,
} from "@workflow/frontend";
import "@workflow/frontend/styles.css";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const DEFAULT_LOCAL_WORKFLOW_ID = "workflow-cloudflare-worker-example";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element not found");
}

createRoot(root).render(
  <App>
    {({ getAccessToken, sidebarFooter }) => (
      <HyloClientShell
        getAccessToken={getAccessToken}
        getLocalWorkflowRegistry={localWorkflowRegistry}
        getRequestedWorker={requestedWorker}
        getWorkflowRegistryConfig={workflowRegistryConfig}
        logPrefix="hylo-client"
        queryKeyPrefix="hylo-client"
        sidebarFooter={sidebarFooter}
        workflowApiUrl={workflowApiUrl}
      />
    )}
  </App>,
);

function workflowRegistryConfig(
  search: HyloClientShellSearch,
): HyloWorkflowRegistryConfig {
  const tenantId = firstNonEmpty(
    search.tenantId,
    import.meta.env.VITE_HYLO_TENANT_ID,
  );
  const explicitUrl = firstNonEmpty(
    search.workflowRegistryUrl,
    import.meta.env.VITE_HYLO_WORKFLOW_REGISTRY_URL,
  );

  if (explicitUrl) {
    return {
      url: tenantId
        ? explicitUrl.replaceAll("{tenantId}", encodeURIComponent(tenantId))
        : explicitUrl,
    };
  }

  return {
    backendUrl: "/api",
    url: tenantId
      ? `/api/tenants/${encodeURIComponent(tenantId)}/workflows`
      : "/api/tenants/me/workflows",
  };
}

function workflowApiUrl(apiBaseUrl: string): string {
  const url = new URL(apiBaseUrl, window.location.origin);
  if (url.pathname.startsWith("/workers/")) {
    return `/worker${url.pathname.slice("/workers".length)}${url.search}${url.hash}`;
  }
  if (
    url.pathname.startsWith("/worker/") ||
    url.origin === window.location.origin
  ) {
    return `${url.pathname}${url.search}${url.hash}`;
  }
  if (isLoopbackUrl(url)) {
    return url.toString();
  }
  return url.toString();
}

function localWorkflowRegistry(): HyloWorkflowRegistry | undefined {
  if (!isLocalDev()) return undefined;
  const workflowId =
    firstNonEmpty(
      requestedWorker({ worker: undefined }),
      import.meta.env.VITE_HYLO_WORKFLOW,
    ) ?? DEFAULT_LOCAL_WORKFLOW_ID;
  return {
    defaultWorkflow: workflowId,
    workflows: {
      [workflowId]: {
        label: labelFromId(workflowId),
        url: `https://${localWorkflowHost(workflowId)}.localhost/api/workflow`,
      },
    },
  };
}

function requestedWorker(search: HyloClientShellSearch): string | undefined {
  return firstNonEmpty(search.worker, import.meta.env.VITE_HYLO_WORKFLOW);
}

function isLocalDev(): boolean {
  if (!import.meta.env.DEV) return false;
  const hostname = window.location.hostname;
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.endsWith(".localhost")
  );
}

function localWorkflowHost(raw: string): string {
  return (
    raw
      .replace(/^@[^/]+\//, "")
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "workflow"
  );
}

function labelFromId(id: string): string {
  return id
    .replace(/^[^.]+\./, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

function firstNonEmpty(
  ...values: (string | null | undefined)[]
): string | undefined {
  return values.map((value) => value?.trim()).find(Boolean);
}

function isLoopbackUrl(url: URL): boolean {
  return (
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1"
  );
}
