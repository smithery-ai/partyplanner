import { OpenAPIHono } from "@hono/zod-openapi";
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
  WorkflowQueue,
  WorkflowRunDocument,
  WorkflowRunSummary,
  WorkflowStateStore,
} from "@workflow/server";
import { cors } from "hono/cors";
import { createRemoteRuntimeRoutes } from "./openapi";

export {
  createRemoteRuntimeOpenApiDocument,
  createRemoteRuntimeRoutes,
  mountRemoteRuntimeOpenApi,
  type RemoteRuntimeOpenApiOptions,
} from "./openapi";

export type RemoteRuntimeServerOptions = {
  stateStore: WorkflowStateStore;
  queue: WorkflowQueue;
  basePath?: string;
  cors?: boolean;
};

export type RemoteRuntimeClientOptions = {
  baseUrl: string;
  fetch?: typeof fetch;
};

export function createRemoteRuntimeServer(options: RemoteRuntimeServerOptions) {
  const app = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success)
        return c.json({ message: result.error.message }, 400);
    },
  });
  const basePath = normalizeBasePath(options.basePath ?? "/runtime");
  const routes = createRemoteRuntimeRoutes(basePath);

  if (options.cors ?? true) {
    app.use(
      "/*",
      cors({
        origin: "*",
        allowHeaders: ["Content-Type"],
        allowMethods: ["GET", "PUT", "POST", "OPTIONS"],
      }),
    );
  }

  app.openapi(routes.health, (c) => c.json({ ok: true as const }, 200));

  app.openapi(routes.listRuns, async (c) => {
    const { workflowId } = c.req.valid("query");
    return c.json(await options.stateStore.listRunSummaries(workflowId), 200);
  });

  app.openapi(routes.getRunState, async (c) => {
    const { runId } = c.req.valid("param");
    const state = await options.stateStore.load(runId);
    if (!state) return c.json({ message: "Unknown run state" }, 404);
    return c.json(state, 200);
  });

  app.openapi(routes.saveRunState, async (c) => {
    try {
      const { runId } = c.req.valid("param");
      const body = c.req.valid("json") as {
        state: RunState;
        expectedVersion?: number;
      };
      return c.json(
        await options.stateStore.save(runId, body.state, body.expectedVersion),
        200,
      );
    } catch (e) {
      return c.json({ message: errorMessage(e) }, 400);
    }
  });

  app.openapi(routes.getAtomValue, async (c) => {
    const key = c.req.valid("json") as AtomPersistenceKey;
    return c.json((await options.stateStore.loadAtomValue(key)) ?? null, 200);
  });

  app.openapi(routes.saveAtomValue, async (c) => {
    try {
      const body = c.req.valid("json") as {
        key: AtomPersistenceKey;
        value: Omit<StoredAtomValue, "createdAt" | "updatedAt">;
      };
      await options.stateStore.saveAtomValue(body.key, body.value);
      return c.json({ ok: true as const }, 200);
    } catch (e) {
      return c.json({ message: errorMessage(e) }, 400);
    }
  });

  app.openapi(routes.listRunEvents, async (c) => {
    const { runId } = c.req.valid("param");
    return c.json(await options.stateStore.listEvents(runId), 200);
  });

  app.openapi(routes.publishEvents, async (c) => {
    try {
      const body = (await readBody(c.req)) as { events?: RunEvent[] };
      const events = body.events ?? [];
      await options.stateStore.publishEvents(events);
      return c.json({ ok: true as const }, 200);
    } catch (e) {
      return c.json({ message: errorMessage(e) }, 400);
    }
  });

  app.openapi(routes.getRunDocument, async (c) => {
    const { runId } = c.req.valid("param");
    const document = await options.stateStore.getRunDocument(runId);
    if (!document) return c.json({ message: "Unknown run" }, 404);
    return c.json(document, 200);
  });

  app.openapi(routes.saveRunDocument, async (c) => {
    try {
      const { runId } = c.req.valid("param");
      const body = c.req.valid("json") as {
        document: WorkflowRunDocument;
      };
      if (body.document.runId !== runId) {
        throw new Error("Document runId does not match route");
      }
      await options.stateStore.saveRunDocument(body.document);
      return c.json({ ok: true as const }, 200);
    } catch (e) {
      return c.json({ message: errorMessage(e) }, 400);
    }
  });

  app.openapi(routes.enqueueEvents, async (c) => {
    try {
      const body = (await readBody(c.req)) as { events?: QueueEvent[] };
      const events = body.events ?? [];
      await options.queue.enqueueMany(events);
      return c.json({ ok: true as const }, 200);
    } catch (e) {
      return c.json({ message: errorMessage(e) }, 400);
    }
  });

  app.openapi(routes.claimQueueItem, async (c) => {
    const { runId } = c.req.valid("param");
    return c.json(
      {
        item: (await options.queue.claimNext(runId)) ?? null,
      },
      200,
    );
  });

  app.openapi(routes.completeQueueItem, async (c) => {
    const { eventId } = c.req.valid("param");
    await options.queue.complete(eventId);
    return c.json({ ok: true as const }, 200);
  });

  app.openapi(routes.failQueueItem, async (c) => {
    try {
      const { eventId } = c.req.valid("param");
      const body = (await readBody(c.req)) as { message?: string };
      await options.queue.fail(
        eventId,
        new Error(body.message ?? "Remote queue item failed"),
      );
      return c.json({ ok: true as const }, 200);
    } catch (e) {
      return c.json({ message: errorMessage(e) }, 400);
    }
  });

  app.openapi(routes.queueSnapshot, async (c) => {
    const { runId } = c.req.valid("param");
    return c.json(await options.queue.snapshot(runId), 200);
  });

  app.openapi(routes.queueSize, async (c) => {
    const { runId } = c.req.valid("param");
    return c.json(
      {
        size: await options.queue.size(runId),
      },
      200,
    );
  });

  return app;
}

export function createRemoteWorkflowStateStore(
  options: string | RemoteRuntimeClientOptions,
): WorkflowStateStore {
  const client = remoteClient(options);
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

export function createRemoteWorkflowQueue(
  options: string | RemoteRuntimeClientOptions,
): WorkflowQueue {
  const client = remoteClient(options);
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

function remoteClient(options: string | RemoteRuntimeClientOptions) {
  const config =
    typeof options === "string" ? { baseUrl: options } : { ...options };
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const fetchImpl = config.fetch ?? fetch;

  return {
    async get<T>(path: string): Promise<T> {
      return readJsonResponse<T>(await fetchImpl(url(baseUrl, path)));
    },
    async getOptional<T>(path: string): Promise<T | undefined> {
      const response = await fetchImpl(url(baseUrl, path));
      if (response.status === 404) return undefined;
      return readJsonResponse<T>(response);
    },
    async post<TBody, TResponse>(
      path: string,
      body: TBody,
    ): Promise<TResponse> {
      return readJsonResponse<TResponse>(
        await fetchImpl(url(baseUrl, path), jsonRequest("POST", body)),
      );
    },
    async put<TBody, TResponse>(path: string, body: TBody): Promise<TResponse> {
      return readJsonResponse<TResponse>(
        await fetchImpl(url(baseUrl, path), jsonRequest("PUT", body)),
      );
    },
  };
}

function jsonRequest(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function normalizeBasePath(basePath: string): string {
  const trimmed = basePath.trim();
  if (!trimmed || trimmed === "/") return "";
  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) throw new Error("Remote runtime baseUrl is required");
  return trimmed.replace(/\/+$/, "");
}

function url(baseUrl: string, path: string): string {
  return `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

async function readBody(req: { json(): Promise<unknown> }): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return {};
  }
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
