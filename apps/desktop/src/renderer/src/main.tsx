import {
  HyloClientShell,
  type HyloClientShellSearch,
  type HyloWorkflowRegistry,
  type HyloWorkflowRegistryConfig,
} from "@workflow/frontend";
import "@workflow/frontend/styles.css";
import { createRoot } from "react-dom/client";
import { App } from "./App";

const DEFAULT_LOCAL_WORKFLOW_ID = "workflow-cloudflare-worker-example";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element not found");
}

createRoot(root).render(
  <App>
    {({ arcadeUserId, getAccessToken, organizationId, sidebarFooter }) => (
      <HyloClientShell
        arcadeUserId={arcadeUserId}
        key={`${organizationId ?? "no-organization"}:${arcadeUserId}`}
        getAccessToken={getAccessToken}
        getLocalWorkflowRegistry={localWorkflowRegistry}
        getRequestedWorker={requestedWorker}
        getWorkflowRegistryConfig={workflowRegistryConfig}
        logPrefix="hylo-desktop"
        queryKeyPrefix="hylo-desktop"
        sidebarFooter={sidebarFooter}
        sidebarTopInset={sidebarTopInset()}
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

  const backendUrl = hyloBackendUrl();
  const registryPath = tenantId
    ? `/tenants/${encodeURIComponent(tenantId)}/workflows`
    : "/tenants/me/workflows";

  return {
    backendUrl,
    url: backendUrl ? `${backendUrl}${registryPath}` : registryPath,
  };
}

function workflowApiUrl(apiBaseUrl: string, backendUrl: string | undefined) {
  if (!backendUrl) return apiBaseUrl;

  let url = new URL(apiBaseUrl, window.location.origin);
  if (isLoopbackUrl(url)) {
    const backend = new URL(backendUrl);
    url = new URL(`${url.pathname}${url.search}${url.hash}`, backend.origin);
  }
  url.searchParams.set("backendUrl", backendUrl);
  return url.origin === window.location.origin
    ? `${url.pathname}${url.search}${url.hash}`
    : url.toString();
}

function localWorkflowRegistry(): HyloWorkflowRegistry | undefined {
  if (!isLocalDev()) return undefined;
  const explicitWorkflow = firstNonEmpty(import.meta.env.VITE_HYLO_WORKFLOW);
  if (!isLocalBackend() && !explicitWorkflow) return undefined;

  const workflowId =
    firstNonEmpty(requestedWorker({ worker: undefined }), explicitWorkflow) ??
    DEFAULT_LOCAL_WORKFLOW_ID;
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

function hyloBackendUrl(): string | undefined {
  return firstNonEmpty(import.meta.env.VITE_HYLO_BACKEND_URL)?.replace(
    /\/+$/,
    "",
  );
}

function sidebarTopInset(): string | undefined {
  return firstNonEmpty(import.meta.env.VITE_HYLO_SIDEBAR_TOP_INSET);
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

function isLocalBackend(): boolean {
  const backendUrl = hyloBackendUrl();
  if (!backendUrl) return false;
  try {
    const hostname = new URL(backendUrl).hostname;
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname.endsWith(".localhost")
    );
  } catch {
    return false;
  }
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
