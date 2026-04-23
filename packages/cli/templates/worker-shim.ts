import { globalRegistry, Registry } from "@workflow/core";
import { RuntimeExecutor } from "@workflow/runtime";
import { createWorkflow } from "@workflow/server";
import "./user-workflow/index";

type Env = {
  HYLO_WORKFLOW_ID?: string;
  HYLO_WORKFLOW_NAME?: string;
  HYLO_WORKFLOW_VERSION?: string;
  HYLO_BACKEND_URL?: string;
  [key: string]: unknown;
};

export default {
  fetch(request, env) {
    return createWorkflow({
      basePath: "/api/workflow",
      backendApi: backendApiUrl(request, env),
      executor: new RuntimeExecutor(secretResolverFromEnv(env)),
      registry: registryWithEnvSecrets(env),
      workflow: {
        id: requireEnv(env, "HYLO_WORKFLOW_ID"),
        name: requireEnv(env, "HYLO_WORKFLOW_NAME"),
        version: requireEnv(env, "HYLO_WORKFLOW_VERSION"),
      },
    }).fetch(request);
  },
} satisfies ExportedHandler<Env>;

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
