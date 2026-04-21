import {
  defaultAuthorizeParams,
  defaultTokenRequest,
  type OAuthProviderSpec,
} from "@workflow/integrations-oauth";
import { Hono } from "hono";
import { z } from "zod";
import type { BrokerStore } from "./store";

// Static credentials per provider, supplied by the host backend from env.
export type BrokerProviderRegistration = {
  spec: OAuthProviderSpec<unknown>;
  clientId: string;
  clientSecret: string;
};

export type AuthenticatedAppIdentity = { appId: string };

export type CreateOAuthBrokerServerOptions = {
  // Externally-visible base URL of the broker, used to build the redirect_uri
  // that the broker registers with each OAuth provider. Must match exactly
  // what's whitelisted in the provider's developer console.
  // E.g. "https://api.example.com/oauth".
  brokerBaseUrl: string;
  store: BrokerStore;
  // Bearer-token check for /start, /exchange, /refresh. Today this is the
  // shared HYLO_API_KEY; later it will return per-org identity.
  authenticateAppToken: (token: string) => AuthenticatedAppIdentity | undefined;
  providers: BrokerProviderRegistration[];
};

const startBodySchema = z.object({
  runtimeHandoffUrl: z.string().url(),
  runId: z.string().min(1),
  interventionId: z.string().min(1),
  scopes: z.array(z.string()).default([]),
  extra: z.record(z.string(), z.string()).default({}),
});

const exchangeBodySchema = z.object({
  handoff: z.string().min(1),
});

const refreshBodySchema = z.object({
  brokerSessionId: z.string().min(1),
});

// Provider-agnostic OAuth broker. Mounts one set of routes per provider:
//   POST /:providerId/start     — runtime asks for an authorize URL
//   GET  /:providerId/callback  — provider redirects user's browser here
//   POST /:providerId/exchange  — runtime trades a one-time handoff for token
//   POST /:providerId/refresh   — runtime asks for a fresh access token
export function createOAuthBrokerServer(
  opts: CreateOAuthBrokerServerOptions,
): Hono {
  const app = new Hono();
  const brokerBaseUrl = trimTrailingSlash(opts.brokerBaseUrl);
  const providers = new Map<string, BrokerProviderRegistration>();
  for (const registration of opts.providers) {
    providers.set(registration.spec.id, registration);
  }

  // POST /:providerId/start
  app.post("/:providerId/start", async (c) => {
    const ident = authenticate(c.req.header("Authorization"), opts);
    if (!ident) return c.json({ error: "unauthorized" }, 401);
    const providerId = c.req.param("providerId");
    const registration = providers.get(providerId);
    if (!registration) return unknownProvider(providerId, c);

    let body: z.infer<typeof startBodySchema>;
    try {
      body = startBodySchema.parse(await readJson(c.req.raw));
    } catch (e) {
      return c.json({ error: "invalid_body", message: errorMessage(e) }, 400);
    }

    const state = randomToken();
    await opts.store.putPending(state, {
      providerId,
      runtimeHandoffUrl: body.runtimeHandoffUrl,
      runId: body.runId,
      interventionId: body.interventionId,
      scopes:
        body.scopes.length > 0 ? body.scopes : registration.spec.defaultScopes,
      extra: body.extra,
      appId: ident.appId,
      createdAt: Date.now(),
    });

    const redirectUri = providerCallbackUrl(brokerBaseUrl, providerId);
    const buildParams =
      registration.spec.buildAuthorizeParams ?? defaultAuthorizeParams;
    const params = buildParams({
      clientId: registration.clientId,
      redirectUri,
      state,
      scopes:
        body.scopes.length > 0 ? body.scopes : registration.spec.defaultScopes,
      extra: body.extra,
    });
    const authorizeUrl = `${registration.spec.authorizeUrl}?${params.toString()}`;
    return c.json({ authorizeUrl });
  });

  // GET /:providerId/callback
  app.get("/:providerId/callback", async (c) => {
    const providerId = c.req.param("providerId");
    const registration = providers.get(providerId);
    if (!registration) return c.text(unknownProviderMessage(providerId), 404);

    const url = new URL(c.req.url);
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    if (!state) return c.text("Missing state", 400);
    const pending = await opts.store.takePending(state);
    if (!pending || pending.providerId !== providerId) {
      return c.text("Unknown or expired state", 400);
    }

    if (error || !code) {
      // Redirect back to the runtime handoff route with `?error=`. Include
      // runId/interventionId so the handoff route can POST `{ error }` to
      // the intervention and the atom can `get.skip(...)`.
      const redirect = appendQuery(pending.runtimeHandoffUrl, {
        error: error ?? "missing_code",
        runId: pending.runId,
        interventionId: pending.interventionId,
      });
      return c.redirect(redirect, 302);
    }

    const redirectUri = providerCallbackUrl(brokerBaseUrl, providerId);
    const tokenRequest = (
      registration.spec.buildTokenRequest ??
      ((ctx) => defaultTokenRequest(registration.spec.tokenUrl, ctx))
    )({
      clientId: registration.clientId,
      clientSecret: registration.clientSecret,
      code,
      redirectUri,
    });

    const tokenResp = await fetch(tokenRequest);
    if (!tokenResp.ok) {
      const text = await tokenResp.text();
      return c.text(
        `Token exchange failed (${tokenResp.status}): ${text.slice(0, 500)}`,
        502,
      );
    }
    const rawToken = await tokenResp.json();
    let shaped: unknown;
    try {
      shaped = registration.spec.shapeToken(rawToken);
      // Validate against the provider's tokenSchema before issuing handoff.
      registration.spec.tokenSchema.parse(shaped);
    } catch (e) {
      return c.text(`Token shaping failed: ${errorMessage(e)}`, 502);
    }

    const brokerSessionId = randomToken();
    const refreshToken = (rawToken as { refresh_token?: string })
      ?.refresh_token;
    if (typeof refreshToken === "string" && refreshToken.length > 0) {
      await opts.store.putRefresh(brokerSessionId, {
        providerId,
        refreshToken,
        appId: pending.appId,
        createdAt: Date.now(),
      });
    }

    // Inject brokerSessionId into the shaped token so the runtime can use it
    // for /refresh later. Token shape contracts include this optional field.
    const tokenWithSession = {
      ...(shaped as Record<string, unknown>),
      brokerSessionId,
    };

    const handoff = randomToken();
    await opts.store.putHandoff(handoff, {
      providerId,
      runId: pending.runId,
      interventionId: pending.interventionId,
      token: tokenWithSession,
      appId: pending.appId,
      createdAt: Date.now(),
    });

    const redirect = appendQuery(pending.runtimeHandoffUrl, { handoff });
    return c.redirect(redirect, 302);
  });

  // POST /:providerId/exchange
  app.post("/:providerId/exchange", async (c) => {
    const ident = authenticate(c.req.header("Authorization"), opts);
    if (!ident) return c.json({ error: "unauthorized" }, 401);
    const providerId = c.req.param("providerId");
    if (!providers.has(providerId)) {
      return unknownProvider(providerId, c);
    }

    let body: z.infer<typeof exchangeBodySchema>;
    try {
      body = exchangeBodySchema.parse(await readJson(c.req.raw));
    } catch (e) {
      return c.json({ error: "invalid_body", message: errorMessage(e) }, 400);
    }

    const issued = await opts.store.takeHandoff(body.handoff);
    if (
      !issued ||
      issued.providerId !== providerId ||
      issued.appId !== ident.appId
    ) {
      return c.json({ error: "invalid_handoff" }, 400);
    }

    return c.json({
      runId: issued.runId,
      interventionId: issued.interventionId,
      token: issued.token,
    });
  });

  // POST /:providerId/refresh — uses stored refresh token to mint new access
  app.post("/:providerId/refresh", async (c) => {
    const ident = authenticate(c.req.header("Authorization"), opts);
    if (!ident) return c.json({ error: "unauthorized" }, 401);
    const providerId = c.req.param("providerId");
    const registration = providers.get(providerId);
    if (!registration) return unknownProvider(providerId, c);

    let body: z.infer<typeof refreshBodySchema>;
    try {
      body = refreshBodySchema.parse(await readJson(c.req.raw));
    } catch (e) {
      return c.json({ error: "invalid_body", message: errorMessage(e) }, 400);
    }

    const stored = await opts.store.getRefresh(body.brokerSessionId);
    if (
      !stored ||
      stored.providerId !== providerId ||
      stored.appId !== ident.appId
    ) {
      return c.json({ error: "unknown_session" }, 404);
    }

    const refreshResp = await fetch(registration.spec.tokenUrl, {
      method: "POST",
      headers: {
        Authorization: `Basic ${base64(`${registration.clientId}:${registration.clientSecret}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: stored.refreshToken,
      }),
    });
    if (!refreshResp.ok) {
      return c.json(
        { error: "refresh_failed", status: refreshResp.status },
        502,
      );
    }
    const rawToken = await refreshResp.json();
    const newRefresh = (rawToken as { refresh_token?: string })?.refresh_token;
    if (typeof newRefresh === "string" && newRefresh.length > 0) {
      await opts.store.updateRefreshToken(body.brokerSessionId, newRefresh);
    }

    const shaped = registration.spec.shapeToken(rawToken);
    const tokenWithSession = {
      ...(shaped as Record<string, unknown>),
      brokerSessionId: body.brokerSessionId,
    };
    return c.json({ token: tokenWithSession });
  });

  return app;
}

function authenticate(
  header: string | undefined,
  opts: CreateOAuthBrokerServerOptions,
): AuthenticatedAppIdentity | undefined {
  if (!header) return undefined;
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return undefined;
  return opts.authenticateAppToken(match[1].trim());
}

function providerCallbackUrl(
  brokerBaseUrl: string,
  providerId: string,
): string {
  return `${brokerBaseUrl}/${providerId}/callback`;
}

function unknownProvider(
  providerId: string,
  c: { json(body: { error: string; message: string }, status: 404): Response },
): Response {
  return c.json(
    {
      error: "unknown_provider",
      message: unknownProviderMessage(providerId),
    },
    404,
  );
}

function unknownProviderMessage(providerId: string): string {
  return `OAuth provider "${providerId}" is not configured on this broker. Set the provider client ID and secret in the backend environment.`;
}

function appendQuery(baseUrl: string, params: Record<string, string>): string {
  const url = new URL(baseUrl);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function randomToken(): string {
  return globalThis.crypto?.randomUUID?.() ?? fallbackRandom();
}

function fallbackRandom(): string {
  // Best-effort fallback if crypto.randomUUID is unavailable. Sufficient
  // entropy for short-lived state/handoff tokens.
  let value = "";
  for (let i = 0; i < 4; i += 1) {
    value += Math.random().toString(36).slice(2);
  }
  return value;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function base64(value: string): string {
  return btoa(unescape(encodeURIComponent(value)));
}

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}
