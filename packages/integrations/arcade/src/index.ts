import {
  type Action,
  type Atom,
  type AtomRuntimeContext,
  action,
  atom,
  type Get,
  type Handle,
  isHandle,
  type RequestIntervention,
  secret,
} from "@workflow/core";
import { defaultAppBaseUrl } from "@workflow/integrations-oauth";
import { Hono } from "hono";
import { type ZodSchema, z } from "zod";

export type ArcadeCredentials = {
  /**
   * Bearer token used for requests to baseUrl. The default `arcade` atom uses
   * the Hylo backend app token; the Arcade project API key stays in the
   * backend environment.
   */
  apiKey: string;
  baseUrl: string;
};

export type ArcadeAuthorizationStatus =
  | "not_started"
  | "pending"
  | "completed"
  | "failed";

export type ArcadeAuthorizationResponse = {
  id?: string;
  providerId?: string;
  scopes?: string[];
  status?: ArcadeAuthorizationStatus;
  url?: string;
  userId?: string;
  raw: unknown;
};

export type ArcadeToolResult<Value> = {
  toolName: string;
  toolVersion?: string;
  id?: string;
  executionId?: string;
  executionType?: string;
  status?: string;
  success?: boolean;
  value: Value;
  logs?: unknown[];
  raw: unknown;
};

export type MaybeHandle<T> = Handle<T> | T;

export type ArcadeToolOptions = {
  auth?: Atom<ArcadeCredentials>;
  userId?: MaybeHandle<string>;
  toolVersion?: MaybeHandle<string | undefined>;
  nextUri?: MaybeHandle<string | undefined>;
  appBaseUrl?: Handle<string>;
  handoffPath?: MaybeHandle<string | undefined>;
  includeErrorStacktrace?: MaybeHandle<boolean | undefined>;
  authorize?: MaybeHandle<boolean | undefined>;
  actionName?: string;
  authorizationTitle?: string;
  authorizationDescription?: string;
  authorizationLabel?: string;
};

export type ResolvableInput<T extends Record<string, unknown>> = {
  [K in keyof T]: MaybeHandle<T[K]> | undefined;
};

type CreateArcadeToolArgs<Input extends Record<string, unknown>, Value> = {
  toolName: string;
  defaultToolVersion?: string;
  input: ResolvableInput<Input>;
  inputSchema: ZodSchema<Input>;
  outputSchema: ZodSchema<Value>;
  opts?: ArcadeToolOptions;
};

type HonoAppLike = {
  fetch(request: Request): Response | Promise<Response>;
};

export type ArcadeHandoffRoutesOptions = {
  workflowApp: HonoAppLike;
  workflowBasePath?: string;
  successTitle?: string;
  errorTitle?: string;
};

const DEFAULT_ARCADE_HANDOFF_PATH = "/api/workflow/integrations/arcade/handoff";

const HYLO_BACKEND_URL = secret(
  "HYLO_BACKEND_URL",
  envVar("HYLO_BACKEND_URL"),
  {
    description: "Hylo backend URL hosting the Arcade proxy.",
    errorMessage: "Set HYLO_BACKEND_URL in the worker environment.",
    internal: true,
  },
);

// Stable dev default matches the backend OAuth/Arcade proxy default so local
// setups work without coordinating app-token env vars.
const DEV_API_KEY = "local-dev-hylo-api-key";

const HYLO_API_KEY = secret("HYLO_API_KEY", resolveApiKey(), {
  description: "Hylo backend app token used to call managed backend services.",
  errorMessage: "Set HYLO_API_KEY in the worker environment.",
  internal: true,
});

function resolveApiKey(): string | undefined {
  const explicit = envVar("HYLO_API_KEY");
  if (explicit) return explicit;
  if (envVar("NODE_ENV") === "production") return undefined;
  return DEV_API_KEY;
}

const ARCADE_USER_ID = secret("ARCADE_USER_ID", envVar("ARCADE_USER_ID"), {
  description:
    "Arcade user ID used for tool authorization. For the Arcade user verifier, use the email address of the signed-in Arcade account.",
  errorMessage:
    "Set ARCADE_USER_ID in the worker environment or pass userId to the Arcade tool.",
});

export const arcade = atom<ArcadeCredentials>(
  (get) => ({
    apiKey: get(HYLO_API_KEY),
    baseUrl: arcadeProxyBaseUrl(get(HYLO_BACKEND_URL)),
  }),
  {
    name: "arcade",
    description: "Arcade proxy credentials resolved from the Hylo backend.",
    internal: true,
  },
);

const authorizationResponseSchema = z
  .object({
    id: z.string().optional(),
    provider_id: z.string().optional(),
    scopes: z.array(z.string()).optional(),
    status: z
      .enum(["not_started", "pending", "completed", "failed"])
      .optional(),
    url: z.string().optional(),
    user_id: z.string().optional(),
  })
  .passthrough();

const responseOutputSchema = z
  .object({
    authorization: authorizationResponseSchema.optional(),
    error: z.unknown().optional(),
    logs: z.array(z.unknown()).optional(),
    value: z.unknown().optional(),
  })
  .passthrough();

const executeToolResponseSchema = z
  .object({
    id: z.string().optional(),
    execution_id: z.string().optional(),
    execution_type: z.string().optional(),
    output: responseOutputSchema.optional(),
    status: z.string().optional(),
    success: z.boolean().optional(),
  })
  .passthrough();

export function createArcadeToolAction<
  Input extends Record<string, unknown>,
  Value,
>(args: CreateArcadeToolArgs<Input, Value>): Action<ArcadeToolResult<Value>> {
  return action(
    (get, requestIntervention, context) =>
      runArcadeTool(args, get, requestIntervention, context),
    {
      name: args.opts?.actionName ?? defaultActionName(args.toolName),
    },
  );
}

export function createArcadeToolAtom<
  Input extends Record<string, unknown>,
  Value,
>(args: CreateArcadeToolArgs<Input, Value>): Atom<ArcadeToolResult<Value>> {
  return atom(
    (get, requestIntervention, context) =>
      runArcadeTool(args, get, requestIntervention, context),
    {
      name: args.opts?.actionName ?? defaultActionName(args.toolName),
    },
  );
}

async function runArcadeTool<Input extends Record<string, unknown>, Value>(
  args: CreateArcadeToolArgs<Input, Value>,
  get: Get,
  requestIntervention: RequestIntervention,
  context: AtomRuntimeContext,
): Promise<ArcadeToolResult<Value>> {
  const credentials = get(args.opts?.auth ?? arcade);
  const userId = resolveUserId(get, args.opts?.userId);
  const toolVersion =
    resolveOptional(get, args.opts?.toolVersion) ?? args.defaultToolVersion;
  const input = args.inputSchema.parse(resolveInput(get, args.input));
  const authorize = resolveOptional(get, args.opts?.authorize) ?? true;
  const interventionKey = `arcade-${sanitizeInterventionKey(args.toolName)}-authorization`;
  const interventionId = context.interventionId(interventionKey);
  const nextUri = resolveArcadeNextUri(get, args.opts, context, interventionId);

  if (authorize) {
    await authorizeTool({
      credentials,
      toolName: args.toolName,
      toolVersion,
      userId,
      nextUri,
      interventionKey,
      requestIntervention,
      opts: args.opts,
    });
  }

  const raw = await arcadeRequest({
    credentials,
    path: "/v1/tools/execute",
    body: {
      tool_name: args.toolName,
      tool_version: toolVersion,
      user_id: userId,
      input,
      include_error_stacktrace: resolveOptional(
        get,
        args.opts?.includeErrorStacktrace,
      ),
    },
  });
  const parsed = executeToolResponseSchema.parse(raw);
  const output = parsed.output;
  if (output?.authorization && output.authorization.status !== "completed") {
    throw new Error(`Arcade authorization is required for ${args.toolName}.`);
  }
  if (parsed.success === false || output?.error) {
    throw new Error(
      `Arcade ${args.toolName} failed: ${formatArcadeError(output?.error)}`,
    );
  }

  return {
    toolName: args.toolName,
    toolVersion,
    id: parsed.id,
    executionId: parsed.execution_id,
    executionType: parsed.execution_type,
    status: parsed.status,
    success: parsed.success,
    value: args.outputSchema.parse(output?.value),
    logs: output?.logs,
    raw,
  };
}

async function authorizeTool(args: {
  credentials: ArcadeCredentials;
  toolName: string;
  toolVersion?: string;
  userId: string;
  nextUri?: string;
  interventionKey: string;
  requestIntervention: RequestIntervention;
  opts?: ArcadeToolOptions;
}): Promise<void> {
  const raw = await arcadeRequest({
    credentials: args.credentials,
    path: "/v1/tools/authorize",
    body: {
      tool_name: args.toolName,
      tool_version: args.toolVersion,
      user_id: args.userId,
      next_uri: args.nextUri,
    },
  });
  let authorization = toAuthorizationResponse(raw);
  if (authorization.status === "completed") return;
  if (!authorization.url) {
    throw new Error(
      `Arcade did not return an authorization URL for ${args.toolName}.`,
    );
  }

  args.requestIntervention(
    args.interventionKey,
    z.object({ ok: z.boolean().optional() }).passthrough(),
    {
      title:
        args.opts?.authorizationTitle ??
        `Authorize ${args.toolName.replace(/^([^.]+)\./, "$1 ")}`,
      description:
        args.opts?.authorizationDescription ??
        "Open Arcade authorization and approve access. The workflow run will resume automatically once authorization completes.",
      action: {
        type: "open_url",
        url: authorization.url,
        label: args.opts?.authorizationLabel ?? "Authorize in Arcade",
      },
      actionUrl: authorization.url,
    },
  );

  if (!authorization.id) return;
  authorization = await checkAuthorizationStatus(
    args.credentials,
    authorization.id,
  );
  if (authorization.status !== "completed") {
    throw new Error(
      `Arcade authorization for ${args.toolName} is ${authorization.status ?? "not completed"}.`,
    );
  }
}

async function checkAuthorizationStatus(
  credentials: ArcadeCredentials,
  id: string,
): Promise<ArcadeAuthorizationResponse> {
  const url = arcadeUrl(credentials.baseUrl, "/v1/auth/status");
  url.searchParams.set("id", id);
  url.searchParams.set("wait", "1");
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${credentials.apiKey}` },
  });
  if (!response.ok) {
    throw new Error(
      `Arcade GET ${url.toString()} failed (${response.status}): ${await response.text()}`,
    );
  }
  return toAuthorizationResponse(await response.json());
}

export function createArcadeHandoffRoutes(
  opts: ArcadeHandoffRoutesOptions,
): Hono {
  const app = new Hono();
  const successTitle = opts.successTitle ?? "Arcade authorization complete";
  const errorTitle = opts.errorTitle ?? "Arcade authorization failed";

  app.get("/handoff", async (c) => {
    const url = new URL(c.req.url);
    const runId = url.searchParams.get("runId");
    const interventionId = url.searchParams.get("interventionId");
    const error = url.searchParams.get("error");

    if (!runId || !interventionId) {
      return htmlResponse(
        errorTitle,
        "Missing runId or interventionId in Arcade handoff URL.",
        400,
      );
    }

    const interventionUrl = buildInterventionUrl(
      url,
      opts.workflowBasePath,
      runId,
      interventionId,
    );
    const response = await opts.workflowApp.fetch(
      new Request(interventionUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payload: error ? { error } : { ok: true } }),
      }),
    );

    if (!response.ok) {
      return htmlResponse(errorTitle, await response.text(), response.status);
    }

    return htmlResponse(
      error ? errorTitle : successTitle,
      error ??
        "The workflow run has been resumed. You can return to the workflow tab.",
      error ? 400 : 200,
    );
  });

  return app;
}

async function arcadeRequest(args: {
  credentials: ArcadeCredentials;
  path: string;
  body: Record<string, unknown>;
}): Promise<unknown> {
  const url = arcadeUrl(args.credentials.baseUrl, args.path);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.credentials.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(compact(args.body)),
  });
  if (!response.ok) {
    throw new Error(
      `Arcade ${url.toString()} failed (${response.status}): ${await response.text()}`,
    );
  }
  return response.json();
}

function arcadeProxyBaseUrl(backendUrl: string): string {
  const url = new URL(backendUrl);
  if (url.hostname.endsWith(".api-worker.hylo.localhost")) {
    url.hostname = "api-worker.hylo.localhost";
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/arcade`;
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function arcadeUrl(baseUrl: string, path: string): URL {
  return new URL(`${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`);
}

function toAuthorizationResponse(raw: unknown): ArcadeAuthorizationResponse {
  const parsed = authorizationResponseSchema.parse(raw);
  return {
    id: parsed.id,
    providerId: parsed.provider_id,
    scopes: parsed.scopes,
    status: parsed.status,
    url: parsed.url,
    userId: parsed.user_id,
    raw,
  };
}

function resolveInput<Input extends Record<string, unknown>>(
  get: Get,
  input: ResolvableInput<Input>,
): Input {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    const item = isHandle(value) ? get(value) : value;
    if (item !== undefined) resolved[key] = item;
  }
  return resolved as Input;
}

function resolveUserId(
  get: Get,
  userId: MaybeHandle<string> | undefined,
): string {
  return userId === undefined ? get(ARCADE_USER_ID) : resolve(get, userId);
}

function resolve<T>(get: Get, value: MaybeHandle<T>): T {
  return isHandle(value) ? get(value) : value;
}

function resolveOptional<T>(
  get: Get,
  value: MaybeHandle<T> | undefined,
): T | undefined {
  return value === undefined ? undefined : resolve(get, value);
}

function resolveArcadeNextUri(
  get: Get,
  opts: ArcadeToolOptions | undefined,
  context: AtomRuntimeContext,
  interventionId: string,
): string | undefined {
  const explicit = resolveOptional(get, opts?.nextUri);
  if (explicit) return explicit;

  const appBaseUrl = get(opts?.appBaseUrl ?? defaultAppBaseUrl);
  const handoffPath: string =
    resolveOptional(get, opts?.handoffPath) ?? DEFAULT_ARCADE_HANDOFF_PATH;
  const url = new URL(resolveUrl(appBaseUrl, handoffPath));
  url.searchParams.set("runId", context.runId);
  url.searchParams.set("interventionId", interventionId);
  return url.toString();
}

function resolveUrl(baseUrl: string, pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  return `${baseUrl.replace(/\/+$/, "")}/${pathOrUrl.replace(/^\/+/, "")}`;
}

function buildInterventionUrl(
  currentUrl: URL,
  workflowBasePath: string | undefined,
  runId: string,
  interventionId: string,
): string {
  const basePath = workflowBasePath ?? "/api/workflow";
  const path = `${basePath.replace(/\/+$/, "")}/runs/${encodeURIComponent(
    runId,
  )}/interventions/${encodeURIComponent(interventionId)}`;
  return `${currentUrl.origin}${path}`;
}

function htmlResponse(title: string, message: string, status = 200): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(
      title,
    )}</title></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(
      message,
    )}</p></body></html>`,
    {
      status,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    },
  );
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      (
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        }) as Record<string, string>
      )[char] ?? char,
  );
}

function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as Partial<T>;
}

function defaultActionName(toolName: string): string {
  return toolName
    .replace(/^[^.]+\./, "")
    .replace(/^[A-Z]/, (value) => value.toLowerCase());
}

function sanitizeInterventionKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function formatArcadeError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return JSON.stringify(error ?? "unknown error");
}

function envVar(name: string): string | undefined {
  const env = (
    globalThis as {
      process?: { env?: Record<string, string | undefined> };
    }
  ).process?.env;
  return env?.[name];
}
