"use client";

/* eslint-disable react-refresh/only-export-components */

import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";
import { type WorkflowNavigation, WorkflowSinglePage } from "./App";
import { ChatPage } from "./chat-page";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./components/ui/alert-dialog";
import { Button } from "./components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
  ComboboxValue,
} from "./components/ui/combobox";

export type HyloWorkflowRegistry = {
  defaultWorkflow?: string;
  workflows: Record<
    string,
    {
      label?: string;
      url: string;
    }
  >;
};

export type HyloWorkflowRegistryConfig = {
  backendUrl?: string;
  url?: string;
};

export type HyloClientShellSearch = {
  tenantId?: string;
  workflowRegistryUrl?: string;
  worker?: string;
};

export type HyloClientShellProps = {
  chatLocalApiBase?: string;
  getAccessToken: () => Promise<string>;
  getLocalWorkflowRegistry?: () => HyloWorkflowRegistry | undefined;
  getRequestedWorker?: (search: HyloClientShellSearch) => string | undefined;
  getWorkflowRegistryConfig: (
    search: HyloClientShellSearch,
  ) => HyloWorkflowRegistryConfig;
  logPrefix?: string;
  queryKeyPrefix?: string;
  sidebarFooter: ReactNode;
  workflowApiUrl: (
    apiBaseUrl: string,
    backendUrl: string | undefined,
  ) => string;
};

type ClientEnvironment = HyloClientShellProps;

const LOCAL_BACKEND_URL = "http://127.0.0.1:8787";
const DEFAULT_QUERY_KEY_PREFIX = "hylo-client-shell";

const ClientEnvironmentContext = createContext<ClientEnvironment | null>(null);
const clientQueryClient = new QueryClient();

const rootRoute = createRootRoute({
  validateSearch: (search): HyloClientShellSearch => ({
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

const workerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/worker/$workerId",
  component: WorkerRouteComponent,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: HomeRouteComponent,
});

const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/chat",
  component: ChatRouteComponent,
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

const workerRunRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/worker/$workerId/runs/$runId",
  component: WorkerRunRouteComponent,
});

const routeTree = rootRoute.addChildren([
  homeRoute,
  workerRoute,
  loginRoute,
  chatRoute,
  connectionInitializingRoute,
  runRoute,
  workerRunRoute,
]);

const router = createRouter({
  routeTree,
  history:
    globalThis.location?.protocol === "file:" ? createHashHistory() : undefined,
  defaultNotFoundComponent: () => (
    <ClientStateMessage>Page not found.</ClientStateMessage>
  ),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

export function HyloClientShell(props: HyloClientShellProps) {
  return (
    <ClientEnvironmentContext.Provider value={props}>
      <QueryClientProvider client={clientQueryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ClientEnvironmentContext.Provider>
  );
}

function RootRouteComponent() {
  return <Outlet />;
}

function HomeRouteComponent() {
  return <ClientApp />;
}

function ChatRouteComponent() {
  const env = useClientEnvironment();
  return (
    <ChatPage
      localApiBase={env.chatLocalApiBase}
      sidebarFooter={env.sidebarFooter}
    />
  );
}

function WorkerRouteComponent() {
  const { workerId } = useParams({ from: workerRoute.id });
  return <ClientApp routeWorkerId={workerId} />;
}

function RunRouteComponent() {
  const { runId } = useParams({ from: runRoute.id });
  return <ClientApp routeRunId={runId} />;
}

function WorkerRunRouteComponent() {
  const { workerId, runId } = useParams({ from: workerRunRoute.id });
  return <ClientApp routeWorkerId={workerId} routeRunId={runId} />;
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

function ClientApp({
  routeRunId,
  routeWorkerId,
}: {
  routeRunId?: string;
  routeWorkerId?: string;
}) {
  const env = useClientEnvironment();
  const navigate = useNavigate();
  const search = useSearch({ from: rootRoute.id });
  const registryConfig = env.getWorkflowRegistryConfig(search);
  const registryQuery = useQuery({
    queryKey: [
      env.queryKeyPrefix ?? DEFAULT_QUERY_KEY_PREFIX,
      "workflow-registry",
      registryConfig.url,
    ],
    enabled: Boolean(registryConfig.url),
    retry: false,
    queryFn: async ({ signal }) => {
      const registryUrl = registryConfig.url;
      if (!registryUrl) {
        throw new Error("Workflow registry could not be loaded.");
      }
      const accessToken = await env.getAccessToken();
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
      `[${env.logPrefix ?? "hylo-client-shell"}] failed to load workflow registry`,
      registryQuery.error,
    );
  }, [env.logPrefix, registryQuery.error]);

  const registry = resolvedWorkflowRegistry(
    registryConfig.url,
    registryQuery,
    env.getLocalWorkflowRegistry,
  );
  const registryError = workflowRegistryError(
    registryConfig.url,
    registryQuery,
  );

  const workflows = registry ? Object.entries(registry.workflows) : [];
  const selectedWorker =
    registry &&
    (parseWorkflowChoice(routeWorkerId, registry) ??
      parseWorkflowChoice(env.getRequestedWorker?.(search), registry) ??
      registry.defaultWorkflow ??
      workflows[0]?.[0]);

  useEffect(() => {
    if (!registry || !selectedWorker) return;
    if (routeWorkerId === selectedWorker && !search.worker) return;
    void navigate({
      to: routeRunId ? "/worker/$workerId/runs/$runId" : "/worker/$workerId",
      params: routeRunId
        ? { workerId: selectedWorker, runId: routeRunId }
        : { workerId: selectedWorker },
      search: withoutWorker,
      replace: true,
    });
  }, [
    navigate,
    registry,
    routeRunId,
    routeWorkerId,
    search.worker,
    selectedWorker,
  ]);

  const onWorkerChange = (worker: string) => {
    void navigate({
      to: "/worker/$workerId",
      params: { workerId: worker },
      search: withoutWorker,
    });
  };
  const resetBackendUrl = onboardingBackendUrl(registryConfig);
  const resetDatabase =
    isLocalDevClient() &&
    resetBackendUrl &&
    isLocalDevBackendUrl(resetBackendUrl)
      ? async () => {
          const backendUrl = resetBackendUrl;
          const resetUrl = `${backendUrl.replace(/\/+$/, "")}/dev/database`;
          const accessToken = await env.getAccessToken();
          const response = await fetch(resetUrl, {
            method: "DELETE",
            headers: workflowRegistryHeaders(resetUrl, accessToken, backendUrl),
          });
          if (!response.ok) {
            throw new Error(await responseErrorMessage(response));
          }
          await clientQueryClient.invalidateQueries({
            queryKey: [
              env.queryKeyPrefix ?? DEFAULT_QUERY_KEY_PREFIX,
              "workflow-registry",
            ],
          });
        }
      : undefined;

  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const onResetDatabase = resetDatabase
    ? () => setResetDialogOpen(true)
    : undefined;
  const resetDialog = resetDatabase ? (
    <ResetDatabaseDialog
      open={resetDialogOpen}
      onOpenChange={setResetDialogOpen}
      doReset={resetDatabase}
    />
  ) : null;

  if (!registry) {
    return <ClientStateMessage>Loading your workers...</ClientStateMessage>;
  }

  if (workflows.length === 0) {
    return (
      <>
        <TenantWorkersEmptyState
          backendUrl={registryConfig.backendUrl}
          registryError={registryError}
          sidebarFooter={env.sidebarFooter}
          onResetDatabase={onResetDatabase}
        />
        {resetDialog}
      </>
    );
  }

  const workflow = registry.workflows[selectedWorker ?? workflows[0][0]];
  const navigation: WorkflowNavigation = {
    home: () => {
      if (!selectedWorker) return;
      void navigate({
        to: "/worker/$workerId",
        params: { workerId: selectedWorker },
        search: withoutWorker,
      });
    },
    workflow: (_workflowId, options) => {
      if (!selectedWorker) return;
      void navigate({
        to: "/worker/$workerId",
        params: { workerId: selectedWorker },
        search: withoutWorker,
        replace: options?.replace,
      });
    },
    run: (_workflowId, runId) => {
      if (!selectedWorker) return;
      void navigate({
        to: "/worker/$workerId/runs/$runId",
        params: { workerId: selectedWorker, runId },
        search: withoutWorker,
      });
    },
  };

  return (
    <>
      <WorkflowSinglePage
        apiBaseUrl={env.workflowApiUrl(workflow.url, registryConfig.backendUrl)}
        managedConnectionInitializingUrl="/connection/initializing"
        runId={routeRunId}
        navigation={navigation}
        sidebarFooter={env.sidebarFooter}
        headerLeading={
          <WorkerSwitcher
            selectedWorker={selectedWorker}
            onResetDatabase={onResetDatabase}
            onWorkerChange={onWorkerChange}
            workflows={workflows}
          />
        }
      />
      {resetDialog}
    </>
  );
}

type WorkerItem =
  | { kind: "worker"; id: string; label: string }
  | { kind: "reset-db"; id: "__reset_db"; label: string };

function WorkerSwitcher({
  selectedWorker,
  onResetDatabase,
  onWorkerChange,
  workflows,
}: {
  selectedWorker: string | undefined;
  onResetDatabase?: () => void;
  onWorkerChange: (worker: string) => void;
  workflows: [string, { label?: string; url: string }][];
}) {
  const items: WorkerItem[] = workflows.map(([id, workflow]) => ({
    kind: "worker" as const,
    id,
    label: workflow.label ?? labelFromId(id),
  }));
  if (onResetDatabase) {
    items.push({
      kind: "reset-db",
      id: "__reset_db",
      label: "Reset DB",
    });
  }
  const value =
    items.find(
      (item) => item.kind === "worker" && item.id === selectedWorker,
    ) ?? null;

  return (
    <Combobox<WorkerItem>
      items={items}
      itemToStringLabel={(item) => item.label}
      itemToStringValue={(item) => item.id}
      isItemEqualToValue={(a, b) => a.id === b.id}
      value={value}
      onValueChange={(next) => {
        if (!next) return;
        if (next.kind === "reset-db") {
          onResetDatabase?.();
          return;
        }
        if (next.id !== selectedWorker) onWorkerChange(next.id);
      }}
    >
      <ComboboxTrigger
        className="inline-flex h-8 min-w-0 max-w-[260px] items-center gap-1.5 rounded-md px-2 text-sm font-semibold tracking-tight outline-none hover:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-base"
        aria-label="Select worker"
      >
        <span className="truncate">
          <ComboboxValue placeholder="Select worker" />
        </span>
      </ComboboxTrigger>
      <ComboboxContent>
        <ComboboxEmpty>No workers</ComboboxEmpty>
        <ComboboxList>
          {(item: WorkerItem) => (
            <ComboboxItem
              key={item.id}
              value={item}
              className={
                item.kind === "reset-db" ? "text-destructive" : undefined
              }
            >
              {item.label}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

function ClientStateMessage({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-dvh place-items-center bg-background p-6 text-center text-sm text-foreground">
      {children}
    </div>
  );
}

function ResetDatabaseDialog({
  open,
  onOpenChange,
  doReset,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  doReset: () => Promise<void>;
}) {
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState("");

  async function confirmReset() {
    setError("");
    setResetting(true);
    try {
      await doReset();
      onOpenChange(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setResetting(false);
    }
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (resetting) return;
        onOpenChange(nextOpen);
        if (nextOpen) setError("");
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Reset local database?</AlertDialogTitle>
          <AlertDialogDescription>
            This deletes every workflow, run, queue, OAuth, and provider row
            from the local database.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? <p className="text-destructive text-sm">{error}</p> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={resetting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            type="button"
            variant="destructive"
            disabled={resetting}
            onClick={(event) => {
              event.preventDefault();
              void confirmReset();
            }}
          >
            {resetting ? (
              <>
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                Resetting
              </>
            ) : (
              "Reset database"
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function TenantWorkersEmptyState({
  backendUrl,
  registryError,
  sidebarFooter,
  onResetDatabase,
}: {
  backendUrl?: string;
  registryError?: string;
  sidebarFooter: ReactNode;
  onResetDatabase?: () => void;
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
          {onResetDatabase ? (
            <div className="mt-4 flex justify-end">
              <Button size="sm" variant="destructive" onClick={onResetDatabase}>
                Reset DB
              </Button>
            </div>
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

function isLocalDevClient(): boolean {
  const hostname = window.location.hostname.toLowerCase();
  return isLocalDevHostname(hostname);
}

function isLocalDevBackendUrl(value: string): boolean {
  try {
    return isLocalDevHostname(
      new URL(value, window.location.origin).hostname.toLowerCase(),
    );
  } catch {
    return false;
  }
}

function isLocalDevHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.endsWith(".localhost")
  );
}

function workflowRegistryHeaders(
  url: string,
  accessToken: string,
  backendUrl: string | undefined,
): HeadersInit {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (isSameOriginUrl(url) || isBackendUrl(url, backendUrl)) {
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

function onboardingBackendUrl(
  config: HyloWorkflowRegistryConfig,
): string | undefined {
  if (config.backendUrl?.trim()) return config.backendUrl.trim();
  const url = config.url?.trim();
  if (!url) return undefined;
  const match = url.match(/^(.*)\/tenants\/[^/]+\/workflows$/);
  return match?.[1];
}

function normalizeWorkflowRegistry(value: unknown): HyloWorkflowRegistry {
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

function emptyWorkflowRegistry(): HyloWorkflowRegistry {
  return { workflows: {} };
}

function parseWorkflowChoice(
  value: string | undefined,
  registry: HyloWorkflowRegistry,
): string | undefined {
  if (!value) return undefined;
  if (value in registry.workflows) return value;
  const pathId = value.replace(/^\.\//, "").split("/").at(-1);
  if (pathId && pathId in registry.workflows) return pathId;
  return undefined;
}

function withoutWorker(search: HyloClientShellSearch): HyloClientShellSearch {
  return {
    ...search,
    worker: undefined,
  };
}

function resolvedWorkflowRegistry(
  url: string | undefined,
  query: {
    data: HyloWorkflowRegistry | undefined;
    error: unknown;
  },
  getLocalWorkflowRegistry:
    | (() => HyloWorkflowRegistry | undefined)
    | undefined,
): HyloWorkflowRegistry | undefined {
  if (!url || query.error) return emptyWorkflowRegistry();
  if (!query.data) return undefined;
  const fallback =
    Object.keys(query.data.workflows).length === 0
      ? getLocalWorkflowRegistry?.()
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

function searchParam(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function responseErrorMessage(response: Response): Promise<string> {
  const fallback = `Request failed with ${response.status}`;
  try {
    const body = (await response.json()) as {
      message?: unknown;
      error?: unknown;
    };
    return (
      (typeof body.message === "string" && body.message) ||
      (typeof body.error === "string" && body.error) ||
      fallback
    );
  } catch {
    return fallback;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
