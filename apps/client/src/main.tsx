import { WorkflowSinglePage } from "@workflow/frontend";
import "@workflow/frontend/styles.css";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

type WorkflowChoice = string | "custom";
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
type WorkflowApiOverride = {
  worker: string;
  url: string;
};

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
  const fallbackRegistry = useMemo(() => workflowRegistry(), []);
  const dynamicRegistryConfig = useMemo(
    () => dynamicWorkflowRegistryConfig(),
    [],
  );
  const [registry, setRegistry] = useState(fallbackRegistry);
  const initialConfig = useMemo(
    () => initialWorkflowConfig(registry),
    [registry],
  );
  const [worker, setWorker] = useState<WorkflowChoice>(initialConfig.worker);
  const [customWorkflowApiUrl, setCustomWorkflowApiUrl] = useState(
    initialConfig.customWorkflowApiUrl,
  );
  const apiBaseUrl = workflowApiBaseUrl({
    worker,
    customWorkflowApiUrl,
    workflowApiOverride: initialConfig.workflowApiOverride,
    registry,
  });

  useEffect(() => {
    if (!dynamicRegistryConfig?.url) return;
    const abort = new AbortController();
    void getAccessToken()
      .then((accessToken) =>
        fetch(dynamicRegistryConfig.url, {
          headers: workflowRegistryHeaders(
            dynamicRegistryConfig.url,
            accessToken,
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
        if (!abort.signal.aborted) setRegistry(nextRegistry);
      })
      .catch((error) => {
        if (!abort.signal.aborted) {
          console.warn("[hylo-client] failed to load workflow registry", error);
        }
      });
    return () => abort.abort();
  }, [dynamicRegistryConfig, getAccessToken]);

  useEffect(() => {
    if (worker === "custom" || worker in registry.workflows) return;
    setWorker(
      registry.defaultWorkflow ??
        Object.keys(registry.workflows)[0] ??
        "custom",
    );
  }, [registry, worker]);

  useEffect(() => {
    writeWorkflowConfigToUrl({
      worker,
      customWorkflowApiUrl,
      workflowApiOverride: initialConfig.workflowApiOverride,
    });
  }, [customWorkflowApiUrl, initialConfig.workflowApiOverride, worker]);

  return (
    <>
      <WorkflowSinglePage
        apiBaseUrl={apiBaseUrl}
        sidebarFooter={sidebarFooter}
      />
      <form className="hylo-client-switcher" aria-label="Workflow routing">
        <label>
          <span>Worker</span>
          <select
            value={worker}
            onChange={(event) =>
              setWorker(event.currentTarget.value as WorkflowChoice)
            }
          >
            {Object.entries(registry.workflows).map(([id, workflow]) => (
              <option key={id} value={id}>
                {workflow.label ?? labelFromId(id)}
              </option>
            ))}
            <option value="custom">Custom URL</option>
          </select>
        </label>

        {worker === "custom" ? (
          <label className="hylo-client-switcher__wide">
            <span>Workflow API</span>
            <input
              value={customWorkflowApiUrl}
              onChange={(event) =>
                setCustomWorkflowApiUrl(event.currentTarget.value)
              }
              placeholder="https://example.com/api/workflow"
              type="url"
            />
          </label>
        ) : null}
      </form>
    </>
  );
}

function initialWorkflowConfig(registry: WorkflowRegistry): {
  worker: WorkflowChoice;
  customWorkflowApiUrl: string;
  workflowApiOverride?: WorkflowApiOverride;
} {
  const params = new URLSearchParams(window.location.search);
  const explicitApiUrl = firstNonEmpty(params.get("workflowApiUrl"));
  const requestedWorker = parseWorkflowChoice(
    firstNonEmpty(params.get("worker"), import.meta.env.VITE_HYLO_WORKFLOW),
    registry,
  );

  return {
    worker:
      explicitApiUrl && !requestedWorker
        ? "custom"
        : (requestedWorker ??
          registry.defaultWorkflow ??
          Object.keys(registry.workflows)[0] ??
          "custom"),
    customWorkflowApiUrl:
      explicitApiUrl && !requestedWorker ? explicitApiUrl : "",
    workflowApiOverride:
      explicitApiUrl && requestedWorker
        ? { worker: requestedWorker, url: explicitApiUrl }
        : undefined,
  };
}

function workflowApiBaseUrl(config: {
  worker: WorkflowChoice;
  customWorkflowApiUrl: string;
  workflowApiOverride?: WorkflowApiOverride;
  registry: WorkflowRegistry;
}): string {
  if (config.worker === "custom") {
    return (
      config.customWorkflowApiUrl.trim() || defaultWorkflowUrl(config.registry)
    );
  }
  if (config.workflowApiOverride?.worker === config.worker) {
    return config.workflowApiOverride.url;
  }
  return (
    config.registry.workflows[config.worker]?.url ??
    defaultWorkflowUrl(config.registry)
  );
}

function writeWorkflowConfigToUrl(config: {
  worker: WorkflowChoice;
  customWorkflowApiUrl: string;
  workflowApiOverride?: WorkflowApiOverride;
}) {
  const url = new URL(window.location.href);

  if (config.worker === "custom") {
    url.searchParams.delete("worker");
    setOrDeleteSearchParam(
      url.searchParams,
      "workflowApiUrl",
      config.customWorkflowApiUrl.trim(),
    );
  } else {
    url.searchParams.set("worker", config.worker);
    if (config.workflowApiOverride?.worker === config.worker) {
      url.searchParams.set("workflowApiUrl", config.workflowApiOverride.url);
    } else {
      url.searchParams.delete("workflowApiUrl");
    }
  }

  window.history.replaceState(null, "", url);
}

function workflowRegistry(): WorkflowRegistry {
  const registry = __HYLO_WORKFLOWS__;
  const params = new URLSearchParams(window.location.search);
  const workflowApiUrl = firstNonEmpty(params.get("workflowApiUrl"));
  const worker = parseWorkflowChoice(
    params.get("worker") ?? undefined,
    registry,
  );

  if (!workflowApiUrl || !worker) return registry;

  return {
    ...registry,
    defaultWorkflow: worker,
    workflows: {
      ...registry.workflows,
      [worker]: {
        ...registry.workflows[worker],
        url: workflowApiUrl,
      },
    },
  };
}

function dynamicWorkflowRegistryConfig(): { url: string } | undefined {
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
      url: expandRegistryUrlTemplate(explicitUrl, tenantId),
    };
  }
  if (!tenantId) {
    return {
      url: "/tenants/me/workflows",
    };
  }
  return {
    url: `/tenants/${encodeURIComponent(tenantId)}/workflows`,
  };
}

function expandRegistryUrlTemplate(url: string, tenantId: string | undefined) {
  if (!tenantId) return url;
  return url.replaceAll("{tenantId}", encodeURIComponent(tenantId));
}

function workflowRegistryHeaders(
  url: string,
  accessToken: string,
): HeadersInit {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (isSameOriginUrl(url)) {
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
  if (entries.length === 0) {
    throw new Error("Workflow registry must include at least one workflow");
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

function parseWorkflowChoice(
  value: string | undefined,
  registry: WorkflowRegistry,
): string | undefined {
  if (!value) return undefined;
  if (value in registry.workflows) return value;
  if (value === "nextjs" && "workflow.nextjs" in registry.workflows) {
    return "workflow.nextjs";
  }
  if (
    value === "cloudflare" &&
    "workflow.cloudflareWorker" in registry.workflows
  ) {
    return "workflow.cloudflareWorker";
  }
  const pathId = value.replace(/^\.\//, "").split("/").at(-1);
  if (pathId && pathId in registry.workflows) return pathId;
  if (pathId === "nextjs" && "workflow.nextjs" in registry.workflows) {
    return "workflow.nextjs";
  }
  if (
    pathId === "cloudflare-worker" &&
    "workflow.cloudflareWorker" in registry.workflows
  ) {
    return "workflow.cloudflareWorker";
  }
  return undefined;
}

function defaultWorkflowUrl(registry: WorkflowRegistry): string {
  const workflow =
    registry.workflows[registry.defaultWorkflow ?? ""] ??
    Object.values(registry.workflows)[0];
  return workflow?.url ?? "/api/nextjs";
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

function setOrDeleteSearchParam(
  params: URLSearchParams,
  name: string,
  value: string | undefined,
) {
  if (value) {
    params.set(name, value);
  } else {
    params.delete(name);
  }
}
