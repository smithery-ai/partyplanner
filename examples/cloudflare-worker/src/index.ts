import { globalRegistry, Registry } from "@workflow/core";
import { RuntimeExecutor } from "@workflow/runtime";
import { createWorkflow, type WorkflowApp } from "@workflow/server";
import "./workflows";

type Env = {
  HYLO_BACKEND_URL?: string;
  INCIDENT_PUBLISHER_TOKEN?: string;
};

export default {
  fetch(request, env) {
    const response = envStatusResponse(request, env);
    if (response) return response;

    return getWorkflowApp(request, env).fetch(request);
  },
} satisfies ExportedHandler<Env>;

function getWorkflowApp(request: Request, env: Env): WorkflowApp {
  const backendApi = backendApiUrl(request, env);
  return createWorkflow({
    basePath: "/api/workflow",
    backendApi,
    executor: new RuntimeExecutor(secretResolverFromEnv(env)),
    registry: registryWithEnvSecrets(env),
    workflow: {
      id: "cloudflare-worker-example",
      version: "v1",
      name: "Cloudflare Worker Example",
    },
  });
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
  for (const action of globalRegistry.allActions()) {
    registry.registerAction(action);
  }
  return registry;
}

function secretResolverFromEnv(env: Env) {
  return {
    resolve: async ({ logicalName }: { logicalName: string }) =>
      envSecretValue(env, logicalName),
  };
}

function backendApiUrl(request: Request, env: Env): string {
  const raw = backendApiUrlFromRequest(request) ?? env.HYLO_BACKEND_URL?.trim();
  if (!raw) {
    throw new Error(
      "HYLO_BACKEND_URL is required, or pass backendUrl on the workflow request.",
    );
  }
  return raw;
}

function backendApiUrlFromRequest(request: Request): string | undefined {
  const url = new URL(request.url);
  const fromQuery =
    url.searchParams.get("backendUrl") ?? url.searchParams.get("backendApi");
  const fromHeader = request.headers.get("x-hylo-backend-url");

  return [fromQuery, fromHeader]
    .map((value) => value?.trim())
    .find((value): value is string => Boolean(value));
}

function envSecretValue(env: Env, logicalName: string): string | undefined {
  if (logicalName !== "INCIDENT_PUBLISHER_TOKEN") return undefined;
  const value = env.INCIDENT_PUBLISHER_TOKEN?.trim();
  return value || undefined;
}

function envStatusResponse(request: Request, env: Env): Response | undefined {
  const url = new URL(request.url);
  if (url.pathname !== "/api/workflow/debug/env") return undefined;

  return Response.json({
    ok: true,
    backendUrl: Boolean(env.HYLO_BACKEND_URL?.trim()),
    secrets: {
      INCIDENT_PUBLISHER_TOKEN: Boolean(
        envSecretValue(env, "INCIDENT_PUBLISHER_TOKEN"),
      ),
    },
  });
}
