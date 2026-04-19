import type { QueueEvent, RunState } from "@workflow/core";
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
import { Hono } from "hono";
import { cors } from "hono/cors";

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
  const app = new Hono();
  const basePath = normalizeBasePath(options.basePath ?? "/runtime");

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

  app.get(routePath(basePath, "/health"), (c) => c.json({ ok: true }));

  app.get(routePath(basePath, "/runs"), async (c) => {
    const workflowId = c.req.query("workflowId");
    return c.json(await options.stateStore.listRunSummaries(workflowId));
  });

  app.get(routePath(basePath, "/runs/:runId/state"), async (c) => {
    const state = await options.stateStore.load(
      requireParam(c.req.param("runId")),
    );
    if (!state) return c.json({ message: "Unknown run state" }, 404);
    return c.json(state);
  });

  app.put(routePath(basePath, "/runs/:runId/state"), async (c) => {
    try {
      const body = (await readBody(c.req)) as {
        state?: RunState;
        expectedVersion?: number;
      };
      if (!body.state) throw new Error("Missing state");
      return c.json(
        await options.stateStore.save(
          requireParam(c.req.param("runId")),
          body.state,
          body.expectedVersion,
        ),
      );
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  app.get(routePath(basePath, "/runs/:runId/events"), async (c) =>
    c.json(
      await options.stateStore.listEvents(requireParam(c.req.param("runId"))),
    ),
  );

  app.post(routePath(basePath, "/events"), async (c) => {
    try {
      const body = (await readBody(c.req)) as { events?: RunEvent[] };
      const events = body.events ?? [];
      await options.stateStore.publishEvents(events);
      return c.json({ ok: true as const });
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  app.get(routePath(basePath, "/runs/:runId/document"), async (c) => {
    const document = await options.stateStore.getRunDocument(
      requireParam(c.req.param("runId")),
    );
    if (!document) return c.json({ message: "Unknown run" }, 404);
    return c.json(document);
  });

  app.put(routePath(basePath, "/runs/:runId/document"), async (c) => {
    try {
      const body = (await readBody(c.req)) as {
        document?: WorkflowRunDocument;
      };
      if (!body.document) throw new Error("Missing document");
      if (body.document.runId !== requireParam(c.req.param("runId"))) {
        throw new Error("Document runId does not match route");
      }
      await options.stateStore.saveRunDocument(body.document);
      return c.json({ ok: true as const });
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  app.post(routePath(basePath, "/queue/enqueue"), async (c) => {
    try {
      const body = (await readBody(c.req)) as { events?: QueueEvent[] };
      const events = body.events ?? [];
      await options.queue.enqueueMany(events);
      return c.json({ ok: true as const });
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  app.post(routePath(basePath, "/queue/:runId/claim"), async (c) =>
    c.json({
      item:
        (await options.queue.claimNext(requireParam(c.req.param("runId")))) ??
        null,
    }),
  );

  app.post(routePath(basePath, "/queue/:eventId/complete"), async (c) => {
    await options.queue.complete(requireParam(c.req.param("eventId")));
    return c.json({ ok: true as const });
  });

  app.post(routePath(basePath, "/queue/:eventId/fail"), async (c) => {
    try {
      const body = (await readBody(c.req)) as { message?: string };
      await options.queue.fail(
        requireParam(c.req.param("eventId")),
        new Error(body.message ?? "Remote queue item failed"),
      );
      return c.json({ ok: true as const });
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  app.get(routePath(basePath, "/queue/:runId/snapshot"), async (c) =>
    c.json(await options.queue.snapshot(requireParam(c.req.param("runId")))),
  );

  app.get(routePath(basePath, "/queue/:runId/size"), async (c) =>
    c.json({
      size: await options.queue.size(requireParam(c.req.param("runId"))),
    }),
  );

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

function routePath(basePath: string, path: string): string {
  return `${basePath}${path}`;
}

function url(baseUrl: string, path: string): string {
  return `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

function requireParam(value: string | undefined): string {
  if (value === undefined) throw new Error("Missing route parameter");
  return value;
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

function errorResponse(
  c: { json(body: { message: string }, status: 400): Response },
  error: unknown,
): Response {
  const message = error instanceof Error ? error.message : String(error);
  return c.json({ message }, 400);
}
