import type { BackendAppEnv } from "./types";

export function resolveBackendPublicUrl(
  env: BackendAppEnv,
  requestOrigin?: string,
): string {
  return (
    env.HYLO_BACKEND_TUNNEL_URL?.trim() ||
    env.HYLO_BACKEND_PUBLIC_URL?.trim() ||
    requestOrigin?.trim() ||
    "https://api-worker.hylo.localhost"
  ).replace(/\/+$/, "");
}

export function resolveBrokerBaseUrl(env: BackendAppEnv): string {
  const explicit = env.HYLO_BROKER_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  return `${resolveBackendPublicUrl(env)}/oauth`;
}
