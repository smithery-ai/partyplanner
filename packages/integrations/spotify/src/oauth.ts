import { type Atom, atom, type Input } from "@workflow/core";
import { signOAuthState } from "@workflow/integrations-oauth";
import { z } from "zod";

export type SpotifyAuth = {
  accessToken: string;
  tokenType: string;
  scopes: string[];
  expiresInSeconds: number;
  refreshToken?: string;
};

export type SpotifyOAuthOptions = {
  // Input carrying a per-run login request. Users submit this to kick off the flow.
  login: Input<{ appBaseUrl: string; showDialog?: boolean }>;
  clientId: Input<string>;
  clientSecret: Input<string>;
  stateSecret: Input<string>;
  // Path the Spotify callback redirects back to, relative to appBaseUrl.
  // Must match the callback path that the Spotify Hono sub-app is mounted at.
  callbackPath?: string;
  scopes?: string[];
  name?: string;
};

const callbackPayloadSchema = z.object({
  code: z.string().optional(),
  state: z.string(),
  error: z.string().optional(),
});

const tokenResponseSchema = z
  .object({
    access_token: z.string(),
    token_type: z.string(),
    scope: z.string().default(""),
    expires_in: z.number(),
    refresh_token: z.string().optional(),
  })
  .passthrough();

export function spotifyOAuth(opts: SpotifyOAuthOptions): Atom<SpotifyAuth> {
  const callbackPath =
    opts.callbackPath ?? "/api/workflow/integrations/spotify/callback";
  const scopes = opts.scopes ?? ["user-read-private", "user-read-email"];

  return atom(
    async (get, requestIntervention, context) => {
      const login = get.maybe(opts.login);
      if (!login) return get.skip("No Spotify login submitted");

      const clientId = get(opts.clientId);
      const clientSecret = get(opts.clientSecret);
      const stateSecret = get(opts.stateSecret);
      const redirectUri = new URL(callbackPath, login.appBaseUrl).toString();

      const interventionKey = "oauth-callback";
      const interventionId = context.interventionId(interventionKey);
      const state = await signOAuthState(
        { runId: context.runId, interventionId, redirectUri },
        stateSecret,
      );

      const authorizeUrl = buildAuthorizeUrl({
        clientId,
        redirectUri,
        state,
        scopes,
        showDialog: login.showDialog ?? false,
      });

      const callback = requestIntervention(
        interventionKey,
        callbackPayloadSchema,
        {
          title: "Connect Spotify",
          description: `Authorize Spotify. Callback URI: ${redirectUri}`,
          action: {
            type: "open_url",
            url: authorizeUrl,
            label: "Connect Spotify",
          },
        },
      );

      if (callback.error) {
        return get.skip(`Spotify authorization failed: ${callback.error}`);
      }
      if (!callback.code) {
        throw new Error("Spotify OAuth callback did not include a code.");
      }
      if (callback.state !== state) {
        throw new Error("Spotify OAuth state mismatch.");
      }

      const token = await exchangeCode({
        clientId,
        clientSecret,
        code: callback.code,
        redirectUri,
      });

      return {
        accessToken: token.access_token,
        tokenType: token.token_type,
        scopes: token.scope.split(/\s+/).filter(Boolean),
        expiresInSeconds: token.expires_in,
        refreshToken: token.refresh_token,
      };
    },
    { name: opts.name ?? "spotifyOAuth" },
  );
}

function buildAuthorizeUrl(args: {
  clientId: string;
  redirectUri: string;
  state: string;
  scopes: string[];
  showDialog: boolean;
}): string {
  const url = new URL("https://accounts.spotify.com/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", args.clientId);
  url.searchParams.set("scope", args.scopes.join(" "));
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("state", args.state);
  if (args.showDialog) url.searchParams.set("show_dialog", "true");
  return url.toString();
}

async function exchangeCode(args: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<z.infer<typeof tokenResponseSchema>> {
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${base64(`${args.clientId}:${args.clientSecret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: args.code,
      redirect_uri: args.redirectUri,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Spotify token exchange failed (${response.status}): ${await preview(response)}`,
    );
  }
  return tokenResponseSchema.parse(await response.json());
}

async function preview(response: Response): Promise<string> {
  const text = await response.text();
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

function base64(value: string): string {
  return btoa(unescape(encodeURIComponent(value)));
}
