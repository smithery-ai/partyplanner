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
    {({ sidebarFooter }) => <ClientApp sidebarFooter={sidebarFooter} />}
  </App>,
);

function ClientApp({ sidebarFooter }: { sidebarFooter: ReactNode }) {
  const registry = useMemo(() => workflowRegistry(), []);
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
