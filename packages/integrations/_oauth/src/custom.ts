import { type Atom, atom, type Handle, type Input } from "@workflow/core";
import { z } from "zod";
import { defaultAppBaseUrl } from "./atom";
import { signOAuthState } from "./legacy";
import {
  defaultAuthorizeParams,
  defaultTokenRequest,
  type OAuthProviderSpec,
} from "./provider";

// User-defined OAuth flow. Use this when Hylo's broker doesn't curate the
// provider you want — e.g. an OAuth app you registered yourself for your own
// product. The worker holds the client_id/secret (in env) and runs the token
// exchange directly. There's no broker hop.
//
// Pair this with a `createOAuthCallbackRoute` mounted on the worker's app.
//
// Compare to `createConnection`, which uses the broker and never exposes
// client_id/secret to worker code (used for Hylo-curated providers).

export type CreateCustomConnectionOptions<Token> = {
  providerSpec: OAuthProviderSpec<Token>;
  // Your OAuth app credentials. Wire these via `secret()` in worker code.
  clientId: Handle<string>;
  clientSecret: Handle<string>;
  // HMAC key used to sign the OAuth state nonce. Must match the value the
  // mounted `createOAuthCallbackRoute` reads via `getStateSecret`.
  stateSecret: Handle<string>;
  // Override the worker app base URL. Defaults to env-backed
  // `defaultAppBaseUrl`. Worker mounts the OAuth callback route here.
  appBaseUrl?: Handle<string>;
  // Path on the worker app where the OAuth callback route is mounted.
  // Defaults to `/api/workflow/integrations/custom/${providerSpec.id}/callback`.
  callbackPath?: string;
  scopes?: string[];
  extra?: Handle<Record<string, string>>;
  waitFor?: Handle<unknown>;
  name?: string;
  description?: string;
  interventionTitle?: string;
  interventionDescription?: string;
  interventionLabel?: string;
};

const callbackPayloadSchema = z.object({
  code: z.string().optional(),
  state: z.string(),
  error: z.string().optional(),
});

// Returns an atom that drives a self-hosted (BYO-credentials) OAuth flow.
// Token exchange happens in worker code with the user's own clientId/secret.
export function createCustomConnection<Token>(
  opts: CreateCustomConnectionOptions<Token>,
): Atom<Token> {
  const { providerSpec } = opts;
  const appBaseUrlHandle = opts.appBaseUrl ?? defaultAppBaseUrl;
  const callbackPath =
    opts.callbackPath ??
    `/api/workflow/integrations/custom/${providerSpec.id}/callback`;
  const scopes = opts.scopes ?? providerSpec.defaultScopes;
  const buildAuthorizeParams =
    providerSpec.buildAuthorizeParams ?? defaultAuthorizeParams;
  const buildTokenRequest =
    providerSpec.buildTokenRequest ??
    ((ctx) => defaultTokenRequest(providerSpec.tokenUrl, ctx));

  return atom(
    async (get, requestIntervention, context) => {
      if (opts.waitFor) get(opts.waitFor);

      const clientId = get(opts.clientId);
      const clientSecret = get(opts.clientSecret);
      const stateSecret = get(opts.stateSecret);
      const appBaseUrl = get(appBaseUrlHandle);
      const extra = opts.extra ? get(opts.extra) : {};
      const redirectUri = new URL(callbackPath, appBaseUrl).toString();

      const interventionKey = "oauth-callback";
      const interventionId = context.interventionId(interventionKey);
      const state = await signOAuthState(
        { runId: context.runId, interventionId, redirectUri },
        stateSecret,
      );

      const params = buildAuthorizeParams({
        clientId,
        redirectUri,
        state,
        scopes,
        extra,
      });
      const authorizeUrl = `${providerSpec.authorizeUrl}?${params.toString()}`;

      const callback = requestIntervention(
        interventionKey,
        callbackPayloadSchema,
        {
          title:
            opts.interventionTitle ?? `Connect ${capitalize(providerSpec.id)}`,
          description:
            opts.interventionDescription ??
            `Authorize ${capitalize(providerSpec.id)}. The workflow run will resume automatically once you approve.`,
          action: {
            type: "open_url",
            url: authorizeUrl,
            label:
              opts.interventionLabel ??
              `Connect ${capitalize(providerSpec.id)}`,
          },
        },
      );

      if (callback.error) {
        return get.skip(
          `${providerSpec.id} authorization failed: ${callback.error}`,
        );
      }
      if (!callback.code) {
        throw new Error(
          `${providerSpec.id} OAuth callback did not include a code.`,
        );
      }
      if (callback.state !== state) {
        throw new Error(`${providerSpec.id} OAuth state mismatch.`);
      }

      const tokenResp = await fetch(
        buildTokenRequest({
          clientId,
          clientSecret,
          code: callback.code,
          redirectUri,
        }),
      );
      if (!tokenResp.ok) {
        const text = await tokenResp.text();
        throw new Error(
          `${providerSpec.id} token exchange failed (${tokenResp.status}): ${text.slice(0, 240)}`,
        );
      }
      const raw = await tokenResp.json();
      const shaped = providerSpec.shapeToken(raw);
      return providerSpec.tokenSchema.parse(shaped);
    },
    {
      name: opts.name ?? `${providerSpec.id}CustomConnection`,
      description:
        opts.description ??
        `Authorize ${capitalize(providerSpec.id)} using worker-held credentials and return the access token.`,
    },
  );
}

// Re-exported for symmetry with createConnection.
export type { Input };

function capitalize(value: string): string {
  if (value.length === 0) return value;
  return `${value[0].toUpperCase()}${value.slice(1)}`;
}
