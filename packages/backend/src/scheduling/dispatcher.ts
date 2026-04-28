import type { WorkflowDeploymentRecord } from "../deployments/registry";

// Source for "which deployments should be ticked?". Most adapters use the
// platform-level deployment list, since cron triggers are not per-tenant on
// platforms like Cloudflare. The dispatcher is intentionally agnostic to *how*
// deployments are enumerated.
export type DeploymentSource = {
  list(): Promise<DeploymentTickTarget[]>;
};

export type DeploymentTickTarget = {
  deploymentId: string;
  // The base URL of the deployment's workflow server. The dispatcher POSTs to
  // `${workflowApiUrl}/schedules/tick` to drive the tenant-side schedule eval.
  workflowApiUrl: string;
  // Optional bearer token forwarded as `Authorization: Bearer <token>` so the
  // tenant worker can authenticate the tick. Omitted when not configured.
  apiKey?: string;
};

export type DispatchTickOptions = {
  source: DeploymentSource;
  fetch?: typeof fetch;
  // Per-tenant timeout in milliseconds. Defaults to 10s; the cron event has its
  // own platform-level timeout that ultimately bounds the total fan-out.
  timeoutMs?: number;
  onError?: (error: unknown, target: DeploymentTickTarget) => void;
};

export type DispatchTickResult = {
  at: string;
  attempted: number;
  ok: number;
  failed: number;
};

export async function dispatchTickToDeployments(
  options: DispatchTickOptions,
  at: Date = new Date(),
): Promise<DispatchTickResult> {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const targets = await options.source.list();
  let ok = 0;
  let failed = 0;

  await Promise.all(
    targets.map(async (target) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (target.apiKey) headers.Authorization = `Bearer ${target.apiKey}`;
        const response = await fetchImpl(
          joinUrl(target.workflowApiUrl, "/schedules/tick"),
          {
            method: "POST",
            headers,
            body: JSON.stringify({ at: at.toISOString() }),
            signal: controller.signal,
          },
        );
        if (!response.ok) {
          failed++;
          options.onError?.(
            new Error(
              `tick ${target.deploymentId} → ${response.status}: ${(await response.text()).slice(0, 200)}`,
            ),
            target,
          );
        } else {
          ok++;
        }
      } catch (error) {
        failed++;
        options.onError?.(error, target);
      } finally {
        clearTimeout(timer);
      }
    }),
  );

  return { at: at.toISOString(), attempted: targets.length, ok, failed };
}

function joinUrl(base: string, path: string): string {
  if (base.endsWith("/") && path.startsWith("/")) return base + path.slice(1);
  if (!base.endsWith("/") && !path.startsWith("/")) return `${base}/${path}`;
  return base + path;
}

// Adapter that turns an iterable of deployments (from any storage) into a
// DeploymentSource. Defers tag/tenant filtering to the caller — the dispatcher
// itself never inspects deployment metadata.
export function deploymentSourceFromList(
  load: () => Promise<WorkflowDeploymentRecord[]>,
  options?: { apiKey?: string },
): DeploymentSource {
  return {
    async list() {
      const records = await load();
      return records
        .filter(
          (
            record,
          ): record is WorkflowDeploymentRecord & { workflowApiUrl: string } =>
            typeof record.workflowApiUrl === "string" &&
            record.workflowApiUrl.length > 0,
        )
        .map((record) => ({
          deploymentId: record.deploymentId,
          workflowApiUrl: record.workflowApiUrl,
          ...(options?.apiKey ? { apiKey: options.apiKey } : {}),
        }));
    },
  };
}
