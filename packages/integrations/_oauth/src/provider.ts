import type { ZodSchema } from "zod";

// Describes a single OAuth provider end-to-end. The same spec is consumed by:
//   - the runtime atom (only needs `id` and `tokenSchema` to type-check the
//     intervention payload)
//   - the broker server, which uses the rest to drive the OAuth dance and
//     shape the token before it crosses back to the runtime.
//
// Provider authors export one of these alongside any helper atoms/actions in
// their integration package (e.g. `@workflow/integrations-spotify` exports
// `spotifyProvider`).
export type OAuthProviderSpec<Token> = {
  // Unique provider id. Used in URL paths and as a key in broker config.
  // Convention: lowercase, no slashes, e.g. "spotify", "notion".
  id: string;
  authorizeUrl: string;
  tokenUrl: string;
  defaultScopes: string[];
  // Schema for the token shape delivered to the runtime atom. Used by both
  // the broker (to validate before issuing a handoff) and the atom (to parse
  // the intervention payload).
  tokenSchema: ZodSchema<Token>;
  // Optional hook to add provider-specific authorize URL params
  // (e.g. Notion needs `owner=user`; Spotify supports `show_dialog`).
  buildAuthorizeParams?: (ctx: AuthorizeParamsContext) => URLSearchParams;
  // Optional hook to override the token-exchange request entirely.
  // Defaults to standard OAuth 2.0 application/x-www-form-urlencoded with
  // HTTP Basic auth on the client credentials.
  buildTokenRequest?: (ctx: TokenRequestContext) => Request;
  // Maps the raw token endpoint response to the provider's `Token` shape.
  // Runs on the broker; result is what the atom ultimately receives.
  shapeToken: (raw: unknown) => Token;
};

export type AuthorizeParamsContext = {
  clientId: string;
  redirectUri: string;
  state: string;
  scopes: string[];
  // Free-form extras forwarded from the runtime atom's `extra` option, e.g.
  // `{ show_dialog: "true" }` for Spotify.
  extra: Record<string, string>;
};

export type TokenRequestContext = {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
};

// Default authorize URL params for a standard OAuth 2.0 authorization code flow.
export function defaultAuthorizeParams(
  ctx: AuthorizeParamsContext,
): URLSearchParams {
  const params = new URLSearchParams();
  params.set("response_type", "code");
  params.set("client_id", ctx.clientId);
  params.set("redirect_uri", ctx.redirectUri);
  params.set("scope", ctx.scopes.join(" "));
  params.set("state", ctx.state);
  for (const [key, value] of Object.entries(ctx.extra)) {
    params.set(key, value);
  }
  return params;
}

// Default token-exchange request. Standard OAuth 2.0 with HTTP Basic auth.
export function defaultTokenRequest(
  url: string,
  ctx: TokenRequestContext,
): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${base64Utf8(`${ctx.clientId}:${ctx.clientSecret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: ctx.code,
      redirect_uri: ctx.redirectUri,
    }),
  });
}

function base64Utf8(value: string): string {
  return btoa(unescape(encodeURIComponent(value)));
}
