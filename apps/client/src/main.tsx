/* eslint-disable react-refresh/only-export-components */

import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import {
  type WorkflowNavigation,
  WorkflowSinglePage,
} from "@workflow/frontend";
import "@workflow/frontend/styles.css";
import { createContext, type ReactNode, useContext, useEffect } from "react";
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

type ClientSearch = {
  tenantId?: string;
  workflowRegistryUrl?: string;
  worker?: string;
};

type ClientEnvironment = {
  getAccessToken: () => Promise<string>;
  sidebarFooter: ReactNode;
};

const LOCAL_BACKEND_URL = "http://127.0.0.1:8787";
const DEFAULT_LOCAL_WORKFLOW_ID = "workflow-cloudflare-worker-example";

const ClientEnvironmentContext = createContext<ClientEnvironment | null>(null);
const clientQueryClient = new QueryClient();

const rootRoute = createRootRoute({
  validateSearch: (search): ClientSearch => ({
    tenantId: searchParam(search.tenantId),
    workflowRegistryUrl: searchParam(search.workflowRegistryUrl),
    worker: searchParam(search.worker),
  }),
  component: RootRouteComponent,
});

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: HomeRouteComponent,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: HomeRouteComponent,
});

const connectionInitializingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/connection/initializing",
  component: ConnectionInitializingRouteComponent,
});

const runRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/runs/$runId",
  component: RunRouteComponent,
});

const routeTree = rootRoute.addChildren([
  homeRoute,
  loginRoute,
  connectionInitializingRoute,
  runRoute,
]);

const router = createRouter({
  routeTree,
  defaultNotFoundComponent: () => (
    <ClientStateMessage>Page not found.</ClientStateMessage>
  ),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element not found");
}

createRoot(root).render(
  <App>
    {({ getAccessToken, sidebarFooter }) => (
      <ClientEnvironmentContext.Provider
        value={{ getAccessToken, sidebarFooter }}
      >
        <QueryClientProvider client={clientQueryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </ClientEnvironmentContext.Provider>
    )}
  </App>,
);

function RootRouteComponent() {
  return <Outlet />;
}

function HomeRouteComponent() {
  return <ClientApp />;
}

function RunRouteComponent() {
  const { runId } = useParams({ from: runRoute.id });
  return <ClientApp routeRunId={runId} />;
}

function ConnectionInitializingRouteComponent() {
  return (
    <div className="grid min-h-dvh place-items-center bg-background p-6 text-foreground">
      <div className="inline-flex items-center gap-3 text-sm font-medium">
        <span
          className="size-4 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground"
          aria-hidden="true"
        />
        Initializing connection
      </div>
    </div>
  );
}

function ClientApp({ routeRunId }: { routeRunId?: string }) {
  const { getAccessToken, sidebarFooter } = useClientEnvironment();
  const navigate = useNavigate();
  const search = useSearch({ from: rootRoute.id });
  const registryConfig = workflowRegistryConfig(search);
  const registryQuery = useQuery({
    queryKey: ["hylo-client", "workflow-registry", registryConfig.url],
    enabled: Boolean(registryConfig.url),
    retry: false,
    queryFn: async ({ signal }) => {
      const registryUrl = registryConfig.url;
      if (!registryUrl) {
        throw new Error("Workflow registry could not be loaded.");
      }
      const accessToken = await getAccessToken();
      const response = await fetch(registryUrl, {
        headers: workflowRegistryHeaders(
          registryUrl,
          accessToken,
          registryConfig.backendUrl,
        ),
        signal,
      });
      if (!response.ok) {
        throw new Error(`Workflow registry failed with ${response.status}`);
      }
      return normalizeWorkflowRegistry(await response.json());
    },
  });

  useEffect(() => {
    if (!registryQuery.error) return;
    console.warn(
      "[hylo-client] failed to load workflow registry",
      registryQuery.error,
    );
  }, [registryQuery.error]);

  const registry = resolvedWorkflowRegistry(registryConfig.url, registryQuery);
  const registryError = workflowRegistryError(
    registryConfig.url,
    registryQuery,
  );

  const workflows = registry ? Object.entries(registry.workflows) : [];
  const selectedWorker =
    registry &&
    (parseWorkflowChoice(requestedWorker(search), registry) ??
      registry.defaultWorkflow ??
      workflows[0]?.[0]);

  useEffect(() => {
    if (!registry || !selectedWorker || search.worker === selectedWorker)
      return;
    void navigate({
      to: routeRunId ? "/runs/$runId" : "/",
      params: routeRunId ? { runId: routeRunId } : undefined,
      search: (previous: ClientSearch) => withWorker(previous, selectedWorker),
      replace: true,
    });
  }, [navigate, registry, routeRunId, search.worker, selectedWorker]);

  const switcher = (
    <ClientSwitcher
      selectedWorker={selectedWorker}
      onWorkerChange={(worker) => {
        void navigate({
          to: "/",
          search: (previous: ClientSearch) => withWorker(previous, worker),
        });
      }}
      workflows={workflows}
    />
  );

  if (!registry) {
    return (
      <>
        <ClientStateMessage>Loading your workers...</ClientStateMessage>
        {switcher}
      </>
    );
  }

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

  const workflow = registry.workflows[selectedWorker ?? workflows[0][0]];
  const navigation: WorkflowNavigation = {
    home: () => {
      void navigate({
        to: "/",
        search: (previous: ClientSearch) =>
          withWorker(previous, selectedWorker),
      });
    },
    workflow: (_workflowId, options) => {
      void navigate({
        to: "/",
        search: (previous: ClientSearch) =>
          withWorker(previous, selectedWorker),
        replace: options?.replace,
      });
    },
    run: (_workflowId, runId) => {
      void navigate({
        to: "/runs/$runId",
        params: { runId },
        search: (previous: ClientSearch) =>
          withWorker(previous, selectedWorker),
      });
    },
  };

  return (
    <>
      <WorkflowSinglePage
        apiBaseUrl={workflowApiUrl(workflow.url)}
        managedConnectionInitializingUrl="/connection/initializing"
        runId={routeRunId}
        navigation={navigation}
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
      new URL(backendUrl, window.location.origin).origin ===
      "https://hylo-backend.smithery.workers.dev"
    );
  } catch {
    return false;
  }
}

function workflowRegistryConfig(search: ClientSearch): WorkflowRegistryConfig {
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

function workflowRegistryHeaders(
  url: string,
  accessToken: string,
  backendUrl: string | undefined,
): HeadersInit {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (
    isSameOriginUrl(url) ||
    isBackendUrl(url, backendUrl ?? workflowRegistryConfig({}).backendUrl)
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
      new URL(backendUrl, window.location.origin).origin
    );
  } catch {
    return false;
  }
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

function requestedWorker(search: ClientSearch): string | undefined {
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

function withWorker(
  search: ClientSearch,
  worker: string | undefined,
): ClientSearch {
  if (!worker) return search;
  return {
    ...search,
    worker,
  };
}

function resolvedWorkflowRegistry(
  url: string | undefined,
  query: {
    data: WorkflowRegistry | undefined;
    error: unknown;
  },
): WorkflowRegistry | undefined {
  if (!url || query.error) return emptyWorkflowRegistry();
  if (!query.data) return undefined;
  const fallback =
    Object.keys(query.data.workflows).length === 0
      ? localWorkflowRegistry()
      : undefined;
  return fallback ?? query.data;
}

function workflowRegistryError(
  url: string | undefined,
  query: {
    error: unknown;
  },
): string | undefined {
  if (!url) return "Workflow registry could not be loaded.";
  if (!query.error) return undefined;
  return query.error instanceof Error
    ? query.error.message
    : "Workflow registry could not be loaded.";
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

function searchParam(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function useClientEnvironment(): ClientEnvironment {
  const value = useContext(ClientEnvironmentContext);
  if (!value) {
    throw new Error(
      "useClientEnvironment must be used within ClientEnvironmentContext",
    );
  }
  return value;
}
