/* eslint-disable react-hooks/set-state-in-effect, react-refresh/only-export-components */
import { WorkflowSinglePage } from "@workflow/frontend";
import "@workflow/frontend/styles.css";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

type WorkflowRegistry = {
  defaultWorkflow?: string;
  workflows: Record<
    string,
    {
      label?: string;
      url: string;
    }
  >;
};

type WorkflowRegistryConfig = {
  backendUrl?: string;
  url?: string;
};

const LOCAL_BACKEND_URL = "http://127.0.0.1:8787";
const DEFAULT_LOCAL_WORKFLOW_ID = "workflow-cloudflare-worker-example";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element not found");
}

createRoot(root).render(
  <App>
    {({ getAccessToken, sidebarFooter }) => (
      <ClientApp
        getAccessToken={getAccessToken}
        sidebarFooter={sidebarFooter}
      />
    )}
  </App>,
);

function ClientApp({
  getAccessToken,
  sidebarFooter,
}: {
  getAccessToken: () => Promise<string>;
  sidebarFooter: ReactNode;
}) {
  const registryConfig = useMemo(() => workflowRegistryConfig(), []);
  const [registry, setRegistry] = useState<WorkflowRegistry>();
  const [registryError, setRegistryError] = useState<string>();
  const [worker, setWorker] = useState<string | undefined>(() =>
    requestedWorker(),
  );

  useEffect(() => {
    const abort = new AbortController();
    setRegistry(undefined);
    setRegistryError(undefined);

    if (!registryConfig.url) {
      setRegistry(emptyWorkflowRegistry());
      setRegistryError("Workflow registry could not be loaded.");
      return () => abort.abort();
    }
    const registryUrl = registryConfig.url;

    void getAccessToken()
      .then((accessToken) =>
        fetch(registryUrl, {
          headers: workflowRegistryHeaders(
            registryUrl,
            accessToken,
            registryConfig.backendUrl,
          ),
          signal: abort.signal,
        }),
      )
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Workflow registry failed with ${response.status}`);
        }
        return normalizeWorkflowRegistry(await response.json());
      })
      .then((nextRegistry) => {
        if (abort.signal.aborted) return;
        const fallback =
          Object.keys(nextRegistry.workflows).length === 0
            ? localWorkflowRegistry()
            : undefined;
        setRegistry(fallback ?? nextRegistry);
      })
      .catch((error) => {
        if (!abort.signal.aborted) {
          console.warn("[hylo-desktop] failed to load workflow registry", error);
          setRegistry(emptyWorkflowRegistry());
          setRegistryError(
            error instanceof Error
              ? error.message
              : "Workflow registry could not be loaded.",
          );
        }
      });

    return () => abort.abort();
  }, [getAccessToken, registryConfig]);

  const switcher = (
    <ClientSwitcher
      selectedWorker={worker}
      onWorkerChange={setWorker}
      workflows={registry ? Object.entries(registry.workflows) : []}
    />
  );

  useEffect(() => {
    if (!registry) return;
    if (worker && worker in registry.workflows) return;
    setWorker(
      parseWorkflowChoice(requestedWorker(), registry) ??
        registry.defaultWorkflow ??
        Object.keys(registry.workflows)[0],
    );
  }, [registry, worker]);

  useEffect(() => {
    if (worker) writeWorkflowConfigToUrl(worker);
  }, [worker]);

  if (!registry) {
    return (
      <>
        <ClientStateMessage>Loading your workers...</ClientStateMessage>
        {switcher}
      </>
    );
  }

  const workflows = Object.entries(registry.workflows);
  if (workflows.length === 0) {
    return (
      <>
        <TenantWorkersEmptyState
          backendUrl={registryConfig.backendUrl}
          registryError={registryError}
          sidebarFooter={sidebarFooter}
        />
        {switcher}
      </>
    );
  }

  const selectedWorker =
    worker && registry.workflows[worker] ? worker : workflows[0][0];
  const workflow = registry.workflows[selectedWorker];

  return (
    <>
      <WorkflowSinglePage
        apiBaseUrl={workflowApiUrl(workflow.url, registryConfig.backendUrl)}
        sidebarFooter={sidebarFooter}
      />
      {switcher}
    </>
  );
}

function ClientSwitcher({
  selectedWorker,
  onWorkerChange,
  workflows,
}: {
  selectedWorker: string | undefined;
  onWorkerChange: (worker: string) => void;
  workflows: [string, { label?: string; url: string }][];
}) {
  const workerValue = workflows.some(([id]) => id === selectedWorker)
    ? selectedWorker
    : "";

  return (
    <form className="hylo-client-switcher" aria-label="Workflow routing">
      <label>
        <span>Worker</span>
        <select
          value={workerValue}
          disabled={workflows.length === 0}
          onChange={(event) => onWorkerChange(event.currentTarget.value)}
        >
          {workflows.length > 0 ? (
            workflows.map(([id, workflow]) => (
              <option key={id} value={id}>
                {workflow.label ?? labelFromId(id)}
              </option>
            ))
          ) : (
            <option value="">No workers</option>
          )}
        </select>
      </label>
    </form>
  );
}

function ClientStateMessage({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-dvh place-items-center bg-background p-6 text-center text-sm text-foreground">
      {children}
    </div>
  );
}

function TenantWorkersEmptyState({
  backendUrl,
  registryError,
  sidebarFooter,
}: {
  backendUrl?: string;
  registryError?: string;
  sidebarFooter: ReactNode;
}) {
  const deployCommand = workflowDeployCommand(backendUrl);
  return (
    <div className="grid min-h-dvh grid-rows-[1fr_auto] bg-background p-6 text-foreground">
      <div className="grid place-items-center">
        <div className="w-full max-w-lg rounded-lg border border-border bg-card p-6 shadow-sm">
          <h1 className="text-lg font-semibold">No workers deployed</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Deploy a worker for this account from a Hylo workflow project.
          </p>
          <pre className="mt-4 overflow-x-auto rounded-md bg-muted p-3 text-left text-xs">
            <code>{deployCommand}</code>
          </pre>
          {registryError ? (
            <p className="mt-3 text-xs text-destructive">{registryError}</p>
          ) : null}
        </div>
      </div>
      <div className="w-64 justify-self-start">{sidebarFooter}</div>
    </div>
  );
}

function workflowDeployCommand(backendUrl: string | undefined): string {
  const backendOption = deployBackendOption(backendUrl);
  return [
    backendOption ? `pnpm hylo auth login \\` : "pnpm hylo auth login",
    ...(backendOption ? [`  ${backendOption}`] : []),
    "",
    backendOption
      ? "pnpm hylo deploy examples/cloudflare-worker \\"
      : "pnpm hylo deploy examples/cloudflare-worker",
    ...(backendOption ? [`  ${backendOption}`] : []),
  ].join("\n");
}

function deployBackendOption(backendUrl: string | undefined): string | null {
  const resolvedBackendUrl = backendUrl ?? LOCAL_BACKEND_URL;
  return isDefaultBackendUrl(resolvedBackendUrl)
    ? null
    : `--backend-url ${resolvedBackendUrl}`;
}

function isDefaultBackendUrl(backendUrl: string): boolean {
  try {
    return (
      new URL(backendUrl).origin === "https://hylo-backend.smithery.workers.dev"
    );
  } catch {
    return false;
  }
}

function workflowRegistryConfig(): WorkflowRegistryConfig {
  const params = new URLSearchParams(window.location.search);
  const tenantId = firstNonEmpty(
    params.get("tenantId"),
    import.meta.env.VITE_HYLO_TENANT_ID,
  );
  const explicitUrl = firstNonEmpty(
    params.get("workflowRegistryUrl"),
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

function hyloBackendUrl(): string | undefined {
  return firstNonEmpty(import.meta.env.VITE_HYLO_BACKEND_URL)?.replace(
    /\/+$/,
    "",
  );
}

function workflowRegistryHeaders(
  url: string,
  accessToken: string,
  backendUrl: string | undefined,
): HeadersInit {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (
    isSameOriginUrl(url) ||
    isBackendUrl(url, backendUrl ?? hyloBackendUrl())
  ) {
    headers.Authorization = `Bearer ${accessToken}`;
  }
  return headers;
}

function isSameOriginUrl(value: string): boolean {
  if (value.startsWith("/")) return true;
  try {
    return new URL(value).origin === window.location.origin;
  } catch {
    return false;
  }
}

function isBackendUrl(value: string, backendUrl: string | undefined): boolean {
  if (!backendUrl) return false;
  try {
    return (
      new URL(value, window.location.origin).origin ===
      new URL(backendUrl).origin
    );
  } catch {
    return false;
  }
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

function isLoopbackUrl(url: URL): boolean {
  return (
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1"
  );
}

function normalizeWorkflowRegistry(value: unknown): WorkflowRegistry {
  if (!value || typeof value !== "object" || !("workflows" in value)) {
    throw new Error("Workflow registry must define workflows");
  }
  const workflows = (value as { workflows?: unknown }).workflows;
  if (!workflows || typeof workflows !== "object") {
    throw new Error("Workflow registry workflows must be an object");
  }

  const entries = Object.entries(workflows).flatMap(([id, config]) => {
    if (!config || typeof config !== "object" || !("url" in config)) {
      return [];
    }
    const url = (config as { url?: unknown }).url;
    if (typeof url !== "string" || !url.trim()) return [];
    const label = (config as { label?: unknown }).label;
    return [
      [
        id,
        {
          ...(typeof label === "string" && label.trim() ? { label } : {}),
          url: url.trim(),
        },
      ] satisfies [string, { label?: string; url: string }],
    ];
  });

  const defaultWorkflow = (value as { defaultWorkflow?: unknown })
    .defaultWorkflow;
  return {
    defaultWorkflow:
      typeof defaultWorkflow === "string" &&
      entries.some(([id]) => id === defaultWorkflow)
        ? defaultWorkflow
        : entries[0]?.[0],
    workflows: Object.fromEntries(entries),
  };
}

function emptyWorkflowRegistry(): WorkflowRegistry {
  return { workflows: {} };
}

function localWorkflowRegistry(): WorkflowRegistry | undefined {
  if (!isLocalDev()) return undefined;
  const workflowId =
    firstNonEmpty(requestedWorker(), import.meta.env.VITE_HYLO_WORKFLOW) ??
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

function parseWorkflowChoice(
  value: string | undefined,
  registry: WorkflowRegistry,
): string | undefined {
  if (!value) return undefined;
  if (value in registry.workflows) return value;
  const pathId = value.replace(/^\.\//, "").split("/").at(-1);
  if (pathId && pathId in registry.workflows) return pathId;
  return undefined;
}

function requestedWorker(): string | undefined {
  return firstNonEmpty(
    new URLSearchParams(window.location.search).get("worker"),
    import.meta.env.VITE_HYLO_WORKFLOW,
  );
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

function writeWorkflowConfigToUrl(worker: string) {
  const url = new URL(window.location.href);
  url.searchParams.set("worker", worker);
  url.searchParams.delete("workflowApiUrl");
  window.history.replaceState(null, "", url);
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
