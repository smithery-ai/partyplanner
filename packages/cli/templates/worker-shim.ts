import { globalRegistry } from "@workflow/core";
import { RuntimeExecutor } from "@workflow/runtime";
import { createWorkflow } from "@workflow/server";
import "./user-workflow";

type Env = {
  HYLO_WORKFLOW_ID?: string;
  HYLO_WORKFLOW_NAME?: string;
  HYLO_WORKFLOW_VERSION?: string;
  HYLO_BACKEND_URL?: string;
};

export default {
  fetch(request, env) {
    return createWorkflow({
      basePath: "/api/workflow",
      backendApi: backendApiUrl(request, env),
      executor: new RuntimeExecutor(),
      registry: globalRegistry,
      workflow: {
        id: requireEnv(env, "HYLO_WORKFLOW_ID"),
        name: requireEnv(env, "HYLO_WORKFLOW_NAME"),
        version: requireEnv(env, "HYLO_WORKFLOW_VERSION"),
      },
    }).fetch(request);
  },
} satisfies ExportedHandler<Env>;

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

function requireEnv(env: Env, key: keyof Env): string {
  const v = env[key]?.trim();
  if (!v) throw new Error(`${String(key)} is required`);
  return v;
}
