import type { WebhookProviderSpec } from "@workflow/integrations-webhook";
import { Hono } from "hono";
import { z } from "zod";
import type { AuthenticatedAppIdentity } from "./server";
import type { WebhookSubscriptionStore } from "./webhook-store";

// Static signing secret per webhook provider, supplied by the host backend.
export type WebhookProviderRegistration = {
  spec: WebhookProviderSpec;
  signingSecret: string;
};

// Called by the webhook server to start a run on the target worker.
// The backend provides the implementation (Cloudflare Dispatcher, HTTP, etc.).
export type WebhookDispatch = (
  deploymentId: string,
  body: { inputId: string; payload: unknown; autoAdvance: boolean },
) => Promise<Response>;

export type CreateWebhookIngressServerOptions = {
  store: WebhookSubscriptionStore;
  authenticateAppToken: (
    token: string,
  ) => AuthenticatedAppIdentity | undefined;
  providers: WebhookProviderRegistration[];
  dispatch: WebhookDispatch;
};

const createSubscriptionBodySchema = z.object({
  tenantId: z.string().min(1),
  providerId: z.string().min(1),
  deploymentId: z.string().min(1),
  inputId: z.string().min(1),
  eventTypes: z.array(z.string()).nullable().default(null),
  config: z.record(z.string(), z.unknown()).default({}),
  mode: z.enum(["create_run", "submit_to_run"]).default("create_run"),
});

// Webhook ingress server. Mounts two groups of routes:
//
//   Subscription management (authenticated):
//     POST   /subscriptions               — create a subscription
//     GET    /subscriptions               — list subscriptions
//     DELETE /subscriptions/:id           — delete a subscription
//
//   Webhook ingress (verified by provider signing secret):
//     POST   /incoming/:providerId/:subscriptionId — receive webhook event
export function createWebhookIngressServer(
  opts: CreateWebhookIngressServerOptions,
): Hono {
  const app = new Hono();
  const providers = new Map<string, WebhookProviderRegistration>();
  for (const reg of opts.providers) {
    providers.set(reg.spec.id, reg);
  }

  // --- Subscription management ---

  app.post("/subscriptions", async (c) => {
    const ident = authenticate(c.req.header("Authorization"), opts);
    if (!ident) return c.json({ error: "unauthorized" }, 401);

    let body: z.infer<typeof createSubscriptionBodySchema>;
    try {
      body = createSubscriptionBodySchema.parse(await readJson(c.req.raw));
    } catch (e) {
      return c.json({ error: "invalid_body", message: errorMessage(e) }, 400);
    }

    const registration = providers.get(body.providerId);
    if (!registration) {
      return c.json(
        {
          error: "unknown_provider",
          message: `Webhook provider "${body.providerId}" is not configured on this backend.`,
        },
        404,
      );
    }

    const id = `whsub_${randomId()}`;
    const now = Date.now();
    await opts.store.create({
      id,
      tenantId: body.tenantId,
      providerId: body.providerId,
      deploymentId: body.deploymentId,
      inputId: body.inputId,
      eventTypes: body.eventTypes,
      config: body.config,
      mode: body.mode,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    return c.json({ id, webhookUrl: `incoming/${body.providerId}/${id}` }, 201);
  });

  app.get("/subscriptions", async (c) => {
    const ident = authenticate(c.req.header("Authorization"), opts);
    if (!ident) return c.json({ error: "unauthorized" }, 401);

    const tenantId = c.req.query("tenantId");
    const subscriptions = await opts.store.list(tenantId ?? undefined);
    return c.json({ subscriptions });
  });

  app.delete("/subscriptions/:id", async (c) => {
    const ident = authenticate(c.req.header("Authorization"), opts);
    if (!ident) return c.json({ error: "unauthorized" }, 401);

    const id = c.req.param("id");
    const existing = await opts.store.get(id);
    if (!existing) return c.json({ error: "not_found" }, 404);

    await opts.store.delete(id);
    return c.json({ ok: true });
  });

  // --- Webhook ingress ---

  app.post("/incoming/:providerId/:subscriptionId", async (c) => {
    const providerId = c.req.param("providerId");
    const subscriptionId = c.req.param("subscriptionId");

    const registration = providers.get(providerId);
    if (!registration) return c.json({ error: "unknown_provider" }, 404);

    // Read raw body once for both verification and parsing.
    const rawBody = await c.req.raw.clone().text();
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }

    // Handle provider setup handshakes (e.g. Slack url_verification).
    if (registration.spec.handleSetup) {
      const setupResponse = registration.spec.handleSetup(body);
      if (setupResponse) return setupResponse;
    }

    // Verify request authenticity.
    const verified = await registration.spec.verifyRequest(
      c.req.raw,
      rawBody,
      registration.signingSecret,
    );
    if (!verified) return c.json({ error: "invalid_signature" }, 401);

    // Look up subscription.
    const subscription = await opts.store.get(subscriptionId);
    if (
      !subscription ||
      subscription.providerId !== providerId ||
      subscription.status !== "active"
    ) {
      return c.json({ error: "unknown_subscription" }, 404);
    }

    // Parse event.
    const { eventType, payload } = registration.spec.parseEvent(body);

    // Apply event type filter.
    if (
      subscription.eventTypes &&
      !subscription.eventTypes.includes(eventType)
    ) {
      return c.json({ ok: true, skipped: true, reason: "filtered" });
    }

    // Dispatch to worker. ACK immediately — the worker processes async.
    try {
      await opts.dispatch(subscription.deploymentId, {
        inputId: subscription.inputId,
        payload,
        autoAdvance: true,
      });
    } catch (e) {
      console.error(
        `[webhook-ingress] dispatch failed for subscription ${subscriptionId}:`,
        errorMessage(e),
      );
      return c.json({ error: "dispatch_failed" }, 502);
    }

    return c.json({ ok: true });
  });

  return app;
}

function authenticate(
  header: string | undefined,
  opts: CreateWebhookIngressServerOptions,
): AuthenticatedAppIdentity | undefined {
  if (!header) return undefined;
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return undefined;
  return opts.authenticateAppToken(match[1].trim());
}

function randomId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}
