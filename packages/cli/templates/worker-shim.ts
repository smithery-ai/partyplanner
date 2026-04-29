import { globalRegistry, Registry } from "@workflow/core";
import { createOAuthHandoffRoutes } from "@workflow/integrations-oauth";
import { RuntimeExecutor } from "@workflow/runtime";
import { createWorkflow } from "@workflow/server";
import "./user-workflow/index";

type Env = {
  HYLO_WORKFLOW_ID?: string;
  HYLO_WORKFLOW_NAME?: string;
  HYLO_WORKFLOW_VERSION?: string;
  HYLO_ORGANIZATION_ID?: string;
  HYLO_BACKEND_URL?: string;
  HYLO_APP_URL?: string;
  HYLO_API_KEY?: string;
  [key: string]: unknown;
};

type WorkflowApp = ReturnType<typeof createWorkflow>;
const workflowAppCache = new Map<string, WorkflowApp>();

// Curated OAuth providers whose handoff routes the shim mounts so brokered
// OAuth resumes the workflow run after the user authorizes in the browser.
const CURATED_OAUTH_PROVIDERS = ["spotify", "notion", "slack"];

export default {
  fetch(request, env) {
    const backendApi = backendApiUrl(request, env);
    const app =
      workflowAppCache.get(backendApi) ?? createCachedApp(env, backendApi);
    if (isArcadeHandoffRequest(request)) {
      return handleArcadeHandoff(request, app, "/api/workflow");
    }
    return app.fetch(request);
  },
} satisfies ExportedHandler<Env>;

function createCachedApp(env: Env, backendApi: string): WorkflowApp {
  const app = createWorkflow({
    basePath: "/api/workflow",
    backendApi,
    executor: new RuntimeExecutor(secretResolverFromEnv(env)),
    registry: registryWithEnvSecrets(env),
    workflow: {
      id: requireEnv(env, "HYLO_WORKFLOW_ID"),
      name: requireEnv(env, "HYLO_WORKFLOW_NAME"),
      organizationId: envSecretValue(env, "HYLO_ORGANIZATION_ID"),
      version: requireEnv(env, "HYLO_WORKFLOW_VERSION"),
    },
  });
  app.route(
    "/api/workflow/integrations",
    createOAuthHandoffRoutes({
      workflowApp: app,
      workflowBasePath: "/api/workflow",
      brokerBaseUrl: `${backendApi.replace(/\/+$/, "")}/oauth`,
      getAppToken: () =>
        typeof env.HYLO_API_KEY === "string" ? env.HYLO_API_KEY : undefined,
      providers: CURATED_OAUTH_PROVIDERS,
    }),
  );
  workflowAppCache.set(backendApi, app);
  return app;
}

function registryWithEnvSecrets(env: Env): Registry {
  const registry = new Registry();
  for (const input of globalRegistry.allInputs()) {
    registry.registerInput({
      ...input,
      secretValue: input.secret
        ? (envSecretValue(env, input.id) ?? input.secretValue)
        : input.secretValue,
    });
  }
  for (const atom of globalRegistry.allAtoms()) registry.registerAtom(atom);
  for (const action of globalRegistry.allActions())
    registry.registerAction(action);
  for (const schedule of globalRegistry.allSchedules())
    registry.registerSchedule(schedule);
  return registry;
}

function secretResolverFromEnv(env: Env) {
  return {
    resolve: async ({ logicalName }: { logicalName: string }) =>
      envSecretValue(env, logicalName),
  };
}

function envSecretValue(env: Env, logicalName: string): string | undefined {
  const value = env[logicalName];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function backendApiUrl(request: Request, env: Env): string {
  const raw = backendApiUrlFromRequest(request) ?? env.HYLO_BACKEND_URL?.trim();
  if (!raw) throw new Error("HYLO_BACKEND_URL is required");
  return raw;
}

function backendApiUrlFromRequest(request: Request): string | undefined {
  const url = new URL(request.url);
  const fromQuery =
    url.searchParams.get("backendUrl") ?? url.searchParams.get("backendApi");
  const fromHeader = request.headers.get("x-hylo-backend-url");
  return [fromQuery, fromHeader]
    .map((v) => v?.trim())
    .find((v): v is string => Boolean(v));
}

function requireEnv(env: Env, key: string): string {
  const value = env[key];
  const v = typeof value === "string" ? value.trim() : undefined;
  if (!v) throw new Error(`${String(key)} is required`);
  return v;
}

function isArcadeHandoffRequest(request: Request): boolean {
  return (
    new URL(request.url).pathname ===
    "/api/workflow/integrations/arcade/handoff"
  );
}

async function handleArcadeHandoff(
  request: Request,
  workflowApp: WorkflowApp,
  workflowBasePath: string,
): Promise<Response> {
  const url = new URL(request.url);
  const runId = url.searchParams.get("runId");
  const interventionId = url.searchParams.get("interventionId");
  const error = url.searchParams.get("error");
  if (!runId || !interventionId) {
    return htmlResponse(
      "Arcade authorization failed",
      "Missing runId or interventionId in Arcade handoff URL.",
      400,
    );
  }

  const interventionUrl = `${url.origin}${workflowBasePath.replace(
    /\/+$/,
    "",
  )}/runs/${encodeURIComponent(runId)}/interventions/${encodeURIComponent(
    interventionId,
  )}`;
  const response = await workflowApp.fetch(
    new Request(interventionUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: error ? { error } : { ok: true } }),
    }),
  );
  if (!response.ok) {
    return htmlResponse(
      "Arcade authorization failed",
      await response.text(),
      response.status,
    );
  }
  return htmlResponse(
    error ? "Arcade authorization failed" : "Arcade authorization complete",
    error ??
      "The workflow run has been resumed. You can return to the workflow tab.",
    error ? 400 : 200,
  );
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
        {
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        } as Record<string, string>
      )[char] ?? char,
  );
}
