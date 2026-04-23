export const DEFAULT_HYLO_BACKEND_URL =
  "https://hylo-backend.smithery.workers.dev";

export function resolveHyloBackendUrl(value: string | undefined): string {
  const resolved =
    value?.trim() ||
    process.env.HYLO_BACKEND_URL?.trim() ||
    DEFAULT_HYLO_BACKEND_URL;
  return resolved.replace(/\/+$/, "");
}
