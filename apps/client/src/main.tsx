import { WorkflowSinglePage } from "@workflow/frontend";
import "@workflow/frontend/styles.css";
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type WorkflowWorker = "nextjs" | "cloudflare";
type WorkerChoice = WorkflowWorker | "custom";
type BackendChoice = "backend-node" | "backend-worker" | "custom";

const backendOptions: Record<Exclude<BackendChoice, "custom">, () => string> = {
  "backend-node": () =>
    import.meta.env.VITE_RESOLVED_BACKEND_NODE_URL ?? "http://localhost:8787",
  "backend-worker": () =>
    import.meta.env.VITE_RESOLVED_BACKEND_WORKER_URL ?? "http://localhost:8788",
};

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element not found");
}

createRoot(root).render(<ClientApp />);

function ClientApp() {
  const initialConfig = useMemo(() => initialWorkflowConfig(), []);
  const [worker, setWorker] = useState<WorkerChoice>(initialConfig.worker);
  const [customWorkflowApiUrl, setCustomWorkflowApiUrl] = useState(
    initialConfig.customWorkflowApiUrl,
  );
  const [backend, setBackend] = useState<BackendChoice>(initialConfig.backend);
  const [customBackendUrl, setCustomBackendUrl] = useState(
    initialConfig.customBackendUrl,
  );
  const apiBaseUrl = workflowApiBaseUrl({
    worker,
    customWorkflowApiUrl,
    backend,
    customBackendUrl,
  });

  useEffect(() => {
    writeWorkflowConfigToUrl({
      worker,
      customWorkflowApiUrl,
      backend,
      customBackendUrl,
    });
  }, [backend, customBackendUrl, customWorkflowApiUrl, worker]);

  return (
    <>
      <WorkflowSinglePage apiBaseUrl={apiBaseUrl} />
      <form className="hylo-client-switcher" aria-label="Workflow routing">
        <label>
          <span>Worker</span>
          <select
            value={worker}
            onChange={(event) =>
              setWorker(event.currentTarget.value as WorkerChoice)
            }
          >
            <option value="nextjs">Next.js</option>
            <option value="cloudflare">Cloudflare Worker</option>
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

        <label>
          <span>Backend</span>
          <select
            value={backend}
            onChange={(event) =>
              setBackend(event.currentTarget.value as BackendChoice)
            }
          >
            <option value="backend-node">apps/backend-node</option>
            <option value="backend-worker">apps/backend</option>
            <option value="custom">Custom URL</option>
          </select>
        </label>

        {backend === "custom" ? (
          <label className="hylo-client-switcher__wide">
            <span>Backend URL</span>
            <input
              value={customBackendUrl}
              onChange={(event) =>
                setCustomBackendUrl(event.currentTarget.value)
              }
              placeholder="https://api.example.com"
              type="url"
            />
          </label>
        ) : null}
      </form>
    </>
  );
}

function initialWorkflowConfig(): {
  worker: WorkerChoice;
  customWorkflowApiUrl: string;
  backend: BackendChoice;
  customBackendUrl: string;
} {
  const params = new URLSearchParams(window.location.search);
  const explicitApiUrl = firstNonEmpty(
    params.get("workflowApiUrl"),
    import.meta.env.VITE_WORKFLOW_API_URL,
    import.meta.env.VITE_BACKEND_URL,
  );
  const backendUrl = firstNonEmpty(
    params.get("backendUrl"),
    import.meta.env.VITE_HYLO_BACKEND_URL,
  );

  return {
    worker: explicitApiUrl
      ? "custom"
      : (parseWorkflowWorker(
          firstNonEmpty(
            params.get("worker"),
            import.meta.env.VITE_WORKFLOW_WORKER,
          ),
        ) ?? "nextjs"),
    customWorkflowApiUrl: explicitApiUrl ?? "",
    backend: backendChoiceForUrl(backendUrl),
    customBackendUrl:
      backendUrl && backendChoiceForUrl(backendUrl) === "custom"
        ? backendUrl
        : "",
  };
}

function workflowApiBaseUrl(config: {
  worker: WorkerChoice;
  customWorkflowApiUrl: string;
  backend: BackendChoice;
  customBackendUrl: string;
}): string {
  const baseUrl =
    config.worker === "custom"
      ? config.customWorkflowApiUrl.trim() || "/api/nextjs"
      : workflowWorkerApiBaseUrl(config.worker);
  return withBackendUrl(
    baseUrl,
    backendUrl(config.backend, config.customBackendUrl),
  );
}

function writeWorkflowConfigToUrl(config: {
  worker: WorkerChoice;
  customWorkflowApiUrl: string;
  backend: BackendChoice;
  customBackendUrl: string;
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
    url.searchParams.delete("workflowApiUrl");
  }

  setOrDeleteSearchParam(
    url.searchParams,
    "backendUrl",
    backendUrl(config.backend, config.customBackendUrl),
  );

  window.history.replaceState(null, "", url);
}

function workflowWorkerApiBaseUrl(worker: WorkflowWorker): string {
  return worker === "cloudflare" ? "/api/cloudflare" : "/api/nextjs";
}

function backendUrl(
  backend: BackendChoice,
  customBackendUrl: string,
): string | undefined {
  if (backend === "custom") return customBackendUrl.trim() || undefined;
  return backendOptions[backend]();
}

function backendChoiceForUrl(value: string | undefined): BackendChoice {
  if (!value) return "backend-node";
  const match = Object.entries(backendOptions).find(
    ([, optionUrl]) => optionUrl() === value,
  );
  return match ? (match[0] as BackendChoice) : "custom";
}

function withBackendUrl(apiBaseUrl: string, backendUrl: string | undefined) {
  if (!backendUrl) return apiBaseUrl;

  const parsed = new URL(apiBaseUrl, window.location.origin);
  parsed.searchParams.set("backendUrl", backendUrl);
  if (isAbsoluteUrl(apiBaseUrl)) return parsed.toString();
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function parseWorkflowWorker(
  value: string | undefined,
): WorkflowWorker | undefined {
  if (value === "cloudflare" || value === "nextjs") return value;
  return undefined;
}

function firstNonEmpty(
  ...values: (string | null | undefined)[]
): string | undefined {
  return values.map((value) => value?.trim()).find(Boolean);
}

function isAbsoluteUrl(value: string): boolean {
  return /^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith("//");
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
