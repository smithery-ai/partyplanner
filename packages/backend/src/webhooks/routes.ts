import type { Context } from "hono";
import { isRecord } from "../utils";
import { createWebhookLogger, type WebhookLogger } from "./log";
import type { ParsedWebhook, WebhookProviderSpec } from "./provider";
import type {
  ProviderInstallationRecord,
  ProviderInstallationRegistry,
} from "./registry";

export type ProviderWebhookForwarder = (
  request: Request,
  context: {
    installation: ProviderInstallationRecord;
    provider: WebhookProviderSpec;
    workerUrl: string;
  },
) => Promise<Response>;

export type ProviderWebhookApiOptions = {
  forward?: ProviderWebhookForwarder;
};

export function mountProviderWebhookApi(
  app: {
    post(
      path: string,
      handler: (c: Context) => Promise<Response> | Response,
    ): void;
    get(
      path: string,
      handler: (c: Context) => Promise<Response> | Response,
    ): void;
    delete(
      path: string,
      handler: (c: Context) => Promise<Response> | Response,
    ): void;
  },
  installations: ProviderInstallationRegistry | undefined,
  providers: WebhookProviderSpec[],
  options: ProviderWebhookApiOptions = {},
): void {
  const providersById = new Map(providers.map((p) => [p.id, p]));
  const forward = options.forward ?? ((request: Request) => fetch(request));

  app.get("/integrations/:providerId/installations", async (c) => {
    const providerId = c.req.param("providerId") ?? "";
    if (!providersById.has(providerId)) {
      return c.json({ error: "unknown_webhook_provider" }, 404);
    }
    if (!installations) {
      return c.json(
        { error: "provider_installation_registry_unavailable" },
        503,
      );
    }
    const records = await installations.list(providerId);
    return c.json({
      installations: records.map((record) => ({
        installationKey: record.installationKey,
        providerId: record.providerId,
        identity: record.identity,
        ...(record.runtimeHandoffUrl
          ? { runtimeHandoffUrl: record.runtimeHandoffUrl }
          : {}),
        ...(record.deploymentId ? { deploymentId: record.deploymentId } : {}),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      })),
    });
  });

  app.delete("/integrations/:providerId/installations/:key", async (c) => {
    const providerId = c.req.param("providerId") ?? "";
    if (!providersById.has(providerId)) {
      return c.json({ error: "unknown_webhook_provider" }, 404);
    }
    if (!installations) {
      return c.json(
        { error: "provider_installation_registry_unavailable" },
        503,
      );
    }
    const key = decodeURIComponent(c.req.param("key") ?? "");
    if (!key) return c.json({ error: "missing_installation_key" }, 400);
    const deleted = await installations.deleteByKey(key);
    if (!deleted) return c.json({ error: "installation_not_found" }, 404);
    return c.json({ ok: true });
  });

  app.post("/integrations/:providerId/events", async (c) => {
    const providerId = c.req.param("providerId") ?? "";
    const log = createWebhookLogger(providerId);
    const provider = providersById.get(providerId);
    if (!provider) {
      log.warn("unknown_provider", {
        registered: [...providersById.keys()],
      });
      return c.json(
        {
          error: "unknown_webhook_provider",
          message: `No webhook provider is registered for "${providerId}".`,
        },
        404,
      );
    }

    const rawBody = await c.req.raw.text();
    log.info("request_received", {
      contentType: c.req.header("content-type") ?? null,
      bodyLength: rawBody.length,
    });

    const verified = await provider.verify(c.req.raw, rawBody);
    if (!verified.ok) {
      log.error("verify_failed", {
        status: verified.status,
        error: verified.error,
        ...(verified.message ? { message: verified.message } : {}),
        ...(verified.diagnostics ?? {}),
      });
      return c.json(
        {
          error: verified.error,
          ...(verified.message ? { message: verified.message } : {}),
        },
        verified.status as 400 | 401 | 403 | 503,
      );
    }

    let parsed: ParsedWebhook;
    try {
      parsed = provider.parse(c.req.header("content-type"), rawBody);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error("parse_failed", { message });
      return c.json(
        {
          error: `invalid_${providerId}_payload`,
          message,
        },
        400,
      );
    }

    const preflight = provider.preflight?.(parsed);
    if (preflight) {
      log.info("preflight_handled", {
        kind: parsed.kind,
        status: preflight.status,
      });
      if ("bodyText" in preflight) {
        return c.body(preflight.bodyText, preflight.status as 200, {
          "content-type": preflight.contentType ?? "text/plain; charset=utf-8",
        });
      }
      return c.json(preflight.bodyJson, preflight.status as 200);
    }

    if (!installations) {
      log.error("registry_unavailable", { kind: parsed.kind });
      return c.json(
        {
          error: "provider_installation_registry_unavailable",
          message: "Provider installation registry is not configured.",
        },
        503,
      );
    }

    const installation = await installations.find({
      providerId: provider.id,
      anyOf: parsed.identity.anyOf,
      ...(parsed.identity.allOf ? { allOf: parsed.identity.allOf } : {}),
    });
    if (!installation) {
      log.warn("installation_not_found", {
        kind: parsed.kind,
        anyOf: parsed.identity.anyOf,
        allOf: parsed.identity.allOf ?? null,
      });
      return c.json(
        {
          error: "provider_installation_not_found",
          message: `No workflow deployment is registered for this ${providerId} installation.`,
        },
        404,
      );
    }

    if (!installation.runtimeHandoffUrl) {
      // Installation isn't bound to any worker (e.g. an "Add to Slack" install
      // that didn't pick a target). Acknowledge so the provider stops
      // retrying, and log so it's visible as an unresolved webhook.
      log.warn("installation_unresolved", {
        kind: parsed.kind,
        installationKey: installation.installationKey,
        identity: installation.identity,
      });
      return c.json({ ok: true, unresolved: true }, 200);
    }

    const workerUrl = workerWebhookUrlFromHandoff(
      installation.runtimeHandoffUrl,
      provider.id,
    );
    if (!workerUrl) {
      log.error("invalid_handoff_url", {
        runtimeHandoffUrl: installation.runtimeHandoffUrl,
      });
      return c.json(
        {
          error: "invalid_runtime_handoff_url",
          message: `Cannot derive a webhook URL from runtimeHandoffUrl "${installation.runtimeHandoffUrl}".`,
        },
        500,
      );
    }

    const runId = extractRunContext(parsed.runContextHints).runId;
    const flattenedIdentity = {
      ...filterStrings(parsed.identity.anyOf),
      ...filterStrings(parsed.identity.allOf ?? {}),
    };

    log.info("forwarding", {
      kind: parsed.kind,
      ...(installation.deploymentId
        ? { deploymentId: installation.deploymentId }
        : {}),
      workerUrl,
      ...(runId ? { runId } : {}),
    });

    let workflowResponse: Response;
    try {
      const workerRequest = new Request(workerUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hylo-original-provider": provider.id,
          "x-hylo-webhook-kind": parsed.kind,
          "x-hylo-webhook-request-id": log.requestId,
        },
        body: JSON.stringify({
          ...(runId ? { runId } : {}),
          payload: {
            source: provider.id,
            kind: parsed.kind,
            ...flattenedIdentity,
            ...(parsed.metadata ?? {}),
            payload: parsed.payload,
          },
        }),
      });
      workflowResponse = await forward(workerRequest, {
        installation,
        provider,
        workerUrl,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error("forward_threw", { workerUrl, message });
      return c.json(
        {
          error: "worker_webhook_forward_failed",
          message: `Worker webhook forwarding threw: ${message}`,
        },
        502,
      );
    }

    if (!workflowResponse.ok) {
      const message = await safeReadResponseText(workflowResponse, log);
      log.error("forward_failed", {
        workerUrl,
        status: workflowResponse.status,
        responseBody: message.slice(0, 1024),
      });
      return c.json(
        {
          error: "worker_webhook_forward_failed",
          message:
            message ||
            `Worker webhook forwarding failed (${workflowResponse.status}).`,
        },
        502,
      );
    }

    log.info("forwarded_ok", {
      workerUrl,
      status: workflowResponse.status,
    });
    return c.json({ ok: true }, 200);
  });
}

async function safeReadResponseText(
  response: Response,
  log: WebhookLogger,
): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    log.warn("forward_response_read_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return "";
  }
}

export function extractRunContext(hints: string[]): {
  runId?: string;
  deploymentId?: string;
} {
  for (const candidate of hints) {
    if (!candidate) continue;
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    const parsed = parseRunContext(trimmed);
    if (parsed.runId || parsed.deploymentId) return parsed;
  }
  return {};
}

function parseRunContext(value: string): {
  runId?: string;
  deploymentId?: string;
} {
  try {
    const parsed = JSON.parse(value);
    if (!isRecord(parsed)) return { runId: value };
    const result: { runId?: string; deploymentId?: string } = {};
    if (typeof parsed.runId === "string" && parsed.runId.trim()) {
      result.runId = parsed.runId;
    }
    if (typeof parsed.deploymentId === "string" && parsed.deploymentId.trim()) {
      result.deploymentId = parsed.deploymentId;
    }
    return result;
  } catch {
    return { runId: value };
  }
}

function filterStrings(value: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(value)) {
    if (val) result[key] = val;
  }
  return result;
}

// runtimeHandoffUrl: <base>/integrations/<providerId>/handoff
// worker webhook URL: <base>/webhooks
export function workerWebhookUrlFromHandoff(
  handoffUrl: string,
  providerId: string,
): string | undefined {
  let url: URL;
  try {
    url = new URL(handoffUrl);
  } catch {
    return undefined;
  }
  const expectedSuffix = `/integrations/${providerId}/handoff`;
  if (url.pathname.endsWith(expectedSuffix)) {
    url.pathname = `${url.pathname.slice(0, -expectedSuffix.length)}/webhooks`;
  } else {
    const replaced = url.pathname.replace(
      /\/integrations\/[^/]+\/handoff$/,
      "/webhooks",
    );
    if (replaced === url.pathname) return undefined;
    url.pathname = replaced;
  }
  url.search = "";
  return url.toString();
}
