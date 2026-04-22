import { globalRegistry, Registry } from "@workflow/core";
import { RuntimeExecutor } from "@workflow/runtime";
import { createWorkflow, type WorkflowApp } from "@workflow/server";
import "./workflows";

type Env = {
  HYLO_BACKEND_URL?: string;
};

export default {
  fetch(request, env) {
    return workflowApp(request, env).fetch(request);
  },
} satisfies ExportedHandler<Env>;

function workflowApp(request: Request, env: Env): WorkflowApp {
  return createWorkflow({
    basePath: "/api/workflow",
    backendApi: backendApiUrl(request, env),
    executor: new RuntimeExecutor({
      resolve: async ({ logicalName }) =>
        envValue(env, logicalName)?.trim() || undefined,
    }),
    registry: cloneRegistryWithEnv(env),
    workflow: {
      id: "__APP_NAME__",
      version: "v1",
      name: "__APP_NAME__",
    },
  });
}

function cloneRegistryWithEnv(env: Env): Registry {
  const registry = new Registry();
  for (const input of globalRegistry.allInputs()) {
    registry.registerInput({
      ...input,
      secretValue: input.secret
        ? (envValue(env, input.id)?.trim() ?? input.secretValue)
        : input.secretValue,
    });
  }
  for (const atom of globalRegistry.allAtoms()) registry.registerAtom(atom);
  for (const action of globalRegistry.allActions()) {
    registry.registerAction(action);
  }
  return registry;
}

function backendApiUrl(request: Request, env: Env): string {
  const url = new URL(request.url);
  const fromQuery =
    url.searchParams.get("backendUrl") ?? url.searchParams.get("backendApi");
  const fromHeader = request.headers.get("x-hylo-backend-url");
  const fromEnv = env.HYLO_BACKEND_URL?.trim();
  const value = [fromQuery, fromHeader, fromEnv]
    .map((v) => v?.trim())
    .find((v): v is string => Boolean(v));
  if (!value) {
    throw new Error(
      "HYLO_BACKEND_URL is required, or pass backendUrl on the workflow request.",
    );
  }
  return value;
}

function envValue(env: Env, key: string): string | undefined {
  return (env as Record<string, string | undefined>)[key];
}
