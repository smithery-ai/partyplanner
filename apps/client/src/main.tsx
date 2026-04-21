import { WorkflowSinglePage } from "@workflow/frontend";
import "@workflow/frontend/styles.css";
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type WorkflowWorker = "nextjs" | "cloudflare";
type WorkerChoice = WorkflowWorker | "custom";

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
  const apiBaseUrl = workflowApiBaseUrl({
    worker,
    customWorkflowApiUrl,
  });

  useEffect(() => {
    writeWorkflowConfigToUrl({
      worker,
      customWorkflowApiUrl,
    });
  }, [customWorkflowApiUrl, worker]);

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
      </form>
    </>
  );
}

function initialWorkflowConfig(): {
  worker: WorkerChoice;
  customWorkflowApiUrl: string;
} {
  const params = new URLSearchParams(window.location.search);
  const explicitApiUrl = firstNonEmpty(params.get("workflowApiUrl"));

  return {
    worker: explicitApiUrl
      ? "custom"
      : (parseWorkflowWorker(
          firstNonEmpty(
            params.get("worker"),
            import.meta.env.VITE_HYLO_WORKFLOW,
          ),
        ) ?? "nextjs"),
    customWorkflowApiUrl: explicitApiUrl ?? "",
  };
}

function workflowApiBaseUrl(config: {
  worker: WorkerChoice;
  customWorkflowApiUrl: string;
}): string {
  const baseUrl =
    config.worker === "custom"
      ? config.customWorkflowApiUrl.trim() || "/api/nextjs"
      : workflowWorkerApiBaseUrl(config.worker);
  return baseUrl;
}

function writeWorkflowConfigToUrl(config: {
  worker: WorkerChoice;
  customWorkflowApiUrl: string;
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

  window.history.replaceState(null, "", url);
}

function workflowWorkerApiBaseUrl(worker: WorkflowWorker): string {
  return worker === "cloudflare" ? "/api/cloudflare" : "/api/nextjs";
}

function parseWorkflowWorker(
  value: string | undefined,
): WorkflowWorker | undefined {
  if (value === "cloudflare" || value === "nextjs") return value;
  if (value === "cloudflare-worker") return "cloudflare";
  if (value === "examples/cloudflare-worker") return "cloudflare";
  if (value === "./examples/cloudflare-worker") return "cloudflare";
  if (value === "examples/nextjs") return "nextjs";
  if (value === "./examples/nextjs") return "nextjs";
  return undefined;
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
