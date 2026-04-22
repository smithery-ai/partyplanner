import type {
  AtomPersistenceKey,
  QueueEvent,
  RunState,
  StoredAtomValue,
} from "@workflow/core";
import type {
  QueueItem,
  QueueSnapshot,
  RunEvent,
  SaveResult,
  StoredRunState,
} from "@workflow/runtime";
import type {
  WorkflowIdentity,
  WorkflowQueue,
  WorkflowRunDocument,
  WorkflowRunSummary,
  WorkflowStateStore,
} from "./types";

export type BackendApiClientOptions = {
  url: string;
  fetch?: typeof fetch;
  getAuthToken?: () => string | undefined;
};

export function createBackendApiWorkflowStateStore(
  options: string | BackendApiClientOptions,
): WorkflowStateStore {
  const client = backendApiClient(options);
  const publishEvents = async (events: RunEvent[]) => {
    await client.post<{ events: RunEvent[] }, { ok: true }>("/events", {
      events,
    });
  };

  return {
    async load(runId) {
      return client.getOptional<StoredRunState>(
        `/runs/${encodeURIComponent(runId)}/state`,
      );
    },
    async save(runId, state, expectedVersion) {
      return client.put<
        { state: RunState; expectedVersion?: number },
        SaveResult
      >(`/runs/${encodeURIComponent(runId)}/state`, { state, expectedVersion });
    },
    async loadAtomValue(key) {
      const value = await client.post<
        AtomPersistenceKey,
        StoredAtomValue | null
      >("/atom-values/load", key);
      return value ?? undefined;
    },
    async saveAtomValue(key, value) {
      await client.put<
        {
          key: AtomPersistenceKey;
          value: Omit<StoredAtomValue, "createdAt" | "updatedAt">;
        },
        { ok: true }
      >("/atom-values", { key, value });
    },
    async publishEvent(event) {
      await publishEvents([event]);
    },
    publishEvents,
    listEvents(runId) {
      return client.get<RunEvent[]>(
        `/runs/${encodeURIComponent(runId)}/events`,
      );
    },
    async saveRunDocument(document) {
      await client.put<{ document: WorkflowRunDocument }, { ok: true }>(
        `/runs/${encodeURIComponent(document.runId)}/document`,
        { document },
      );
    },
    getRunDocument(runId) {
      return client.getOptional<WorkflowRunDocument>(
        `/runs/${encodeURIComponent(runId)}/document`,
      );
    },
    listRunSummaries(workflowId) {
      const suffix = workflowId
        ? `?workflowId=${encodeURIComponent(workflowId)}`
        : "";
      return client.get<WorkflowRunSummary[]>(`/runs${suffix}`);
    },
  };
}

export function createBackendApiWorkflowQueue(
  options: string | BackendApiClientOptions,
): WorkflowQueue {
  const client = backendApiClient(options);
  const enqueueMany = async (events: QueueEvent[]) => {
    await client.post<{ events: QueueEvent[] }, { ok: true }>(
      "/queue/enqueue",
      {
        events,
      },
    );
  };

  return {
    enqueue(event) {
      return enqueueMany([event]);
    },
    enqueueMany,
    async claimNext(runId) {
      const response = await client.post<
        Record<string, never>,
        { item: QueueItem | null }
      >(`/queue/${encodeURIComponent(runId)}/claim`, {});
      return response.item ?? undefined;
    },
    async complete(eventId) {
      await client.post<Record<string, never>, { ok: true }>(
        `/queue/${encodeURIComponent(eventId)}/complete`,
        {},
      );
    },
    async fail(eventId, error) {
      await client.post<{ message: string }, { ok: true }>(
        `/queue/${encodeURIComponent(eventId)}/fail`,
        { message: error.message },
      );
    },
    snapshot(runId) {
      return client.get<QueueSnapshot>(
        `/queue/${encodeURIComponent(runId)}/snapshot`,
      );
    },
    async size(runId) {
      const response = await client.get<{ size: number }>(
        `/queue/${encodeURIComponent(runId)}/size`,
      );
      return response.size;
    },
  };
}

export function createBackendApiWorkflowIdentityResolver(
  options: BackendApiClientOptions,
): () => Promise<WorkflowIdentity> {
  const client = backendApiClient(options);
  return () => client.get<WorkflowIdentity>("/identity");
}

export function backendApiHasAuth(
  options: string | BackendApiClientOptions,
): options is BackendApiClientOptions {
  return (
    typeof options !== "string" && typeof options.getAuthToken === "function"
  );
}

function backendApiClient(options: string | BackendApiClientOptions) {
  const config =
    typeof options === "string" ? { url: options } : { ...options };
  const baseUrl = normalizeBackendApiUrl(config.url);
  const fetchImpl = config.fetch ?? fetch;

  return {
    async get<T>(path: string): Promise<T> {
      return readJsonResponse<T>(
        await fetchImpl(url(baseUrl, path), request("GET", config)),
      );
    },
    async getOptional<T>(path: string): Promise<T | undefined> {
      const response = await fetchImpl(
        url(baseUrl, path),
        request("GET", config),
      );
      if (response.status === 404) return undefined;
      return readJsonResponse<T>(response);
    },
    async post<TBody, TResponse>(
      path: string,
      body: TBody,
    ): Promise<TResponse> {
      return readJsonResponse<TResponse>(
        await fetchImpl(url(baseUrl, path), jsonRequest("POST", body, config)),
      );
    },
    async put<TBody, TResponse>(path: string, body: TBody): Promise<TResponse> {
      return readJsonResponse<TResponse>(
        await fetchImpl(url(baseUrl, path), jsonRequest("PUT", body, config)),
      );
    },
  };
}

function request(
  method: string,
  config: { getAuthToken?: () => string | undefined },
): RequestInit {
  return {
    method,
    headers: headers(config),
  };
}

function jsonRequest(
  method: string,
  body: unknown,
  config: { getAuthToken?: () => string | undefined },
): RequestInit {
  return {
    method,
    headers: headers(config, { "content-type": "application/json" }),
    body: JSON.stringify(body),
  };
}

function headers(
  config: { getAuthToken?: () => string | undefined },
  base: Record<string, string> = {},
): Record<string, string> {
  const token = config.getAuthToken?.()?.trim();
  return token ? { ...base, Authorization: `Bearer ${token}` } : base;
}

function normalizeBackendApiUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) throw new Error("backendApi URL is required");
  const baseUrl = trimmed.replace(/\/+$/, "");
  return baseUrl.endsWith("/runtime") ? baseUrl : `${baseUrl}/runtime`;
}

function url(baseUrl: string, path: string): string {
  return `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "message" in body
        ? String((body as { message: unknown }).message)
        : `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return body as T;
}
