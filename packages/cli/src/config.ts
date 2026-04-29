export const DEFAULT_HYLO_BACKEND_URL = "https://backend.flamecast.dev";
export const LOCAL_HYLO_BACKEND_URL = "https://api-worker.hylo.localhost";

export type BackendSelection = {
  local?: boolean;
};

export function resolveHyloBackendUrl(options: BackendSelection = {}): string {
  const resolved = options.local
    ? LOCAL_HYLO_BACKEND_URL
    : DEFAULT_HYLO_BACKEND_URL;
  return resolved.replace(/\/+$/, "");
}
