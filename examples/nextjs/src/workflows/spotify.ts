import { atom, input, secret } from "@workflow/core";
import { z } from "zod";

const spotifyCallbackPayloadSchema = z.object({
  code: z.string().optional(),
  state: z.string(),
  error: z.string().optional(),
});

const spotifyTokenResponseSchema = z
  .object({
    access_token: z.string(),
    token_type: z.string(),
    scope: z.string().default(""),
    expires_in: z.number(),
    refresh_token: z.string().optional(),
  })
  .passthrough();

const spotifyProfileSchema = z
  .object({
    id: z.string(),
    display_name: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    country: z.string().optional(),
    product: z.string().optional(),
    followers: z.object({ total: z.number().optional() }).optional(),
    external_urls: z.object({ spotify: z.string().optional() }).optional(),
  })
  .passthrough();

const spotifyOAuthStateSchema = z.object({
  runId: z.string(),
  interventionId: z.string(),
  redirectUri: z.string().url(),
  signature: z.string(),
});

type SpotifyOAuthStatePayload = Omit<
  z.infer<typeof spotifyOAuthStateSchema>,
  "signature"
>;

export const spotifyLogin = input(
  "spotifyLogin",
  z.object({
    appBaseUrl: z.string().url().default(defaultAppBaseUrl()),
    showDialog: z.boolean().default(false),
  }),
  {
    description: "Connect Spotify and read the current user's profile.",
  },
);

export const spotifyClientId = secret(
  "SPOTIFY_CLIENT_ID",
  process.env.SPOTIFY_CLIENT_ID,
  {
    description: "Spotify application client ID.",
    errorMessage:
      "Set process.env.SPOTIFY_CLIENT_ID in the Next.js environment.",
  },
);

export const spotifyClientSecret = secret(
  "SPOTIFY_CLIENT_SECRET",
  process.env.SPOTIFY_CLIENT_SECRET,
  {
    description: "Spotify application client secret.",
    errorMessage:
      "Set process.env.SPOTIFY_CLIENT_SECRET in the Next.js environment.",
  },
);

export function spotifyOauthStateSecretValue(): string | undefined {
  return process.env.OAUTH_STATE_SECRET;
}

export const oauthStateSecret = secret(
  "OAUTH_STATE_SECRET",
  spotifyOauthStateSecretValue(),
  {
    description: "Secret used to sign Spotify OAuth state values.",
    errorMessage:
      "Set process.env.OAUTH_STATE_SECRET in the Next.js environment.",
  },
);

export const spotifyProfile = atom(
  async (get, requestIntervention, context) => {
    const login = get.maybe(spotifyLogin);
    if (!login) return get.skip("No Spotify login was submitted");

    const clientId = get(spotifyClientId);
    const clientSecret = get(spotifyClientSecret);
    const stateSecret = get(oauthStateSecret);
    const redirectUri = spotifyCallbackRedirectUri(login.appBaseUrl);
    const interventionKey = "oauth-callback";
    const interventionId = context.interventionId(interventionKey);
    const state = await createSpotifyOAuthState(
      {
        runId: context.runId,
        interventionId,
        redirectUri,
      },
      stateSecret,
    );
    const authorizeUrl = spotifyAuthorizeUrl({
      clientId,
      redirectUri,
      state,
      showDialog: login.showDialog,
    });

    const callback = requestIntervention(
      interventionKey,
      spotifyCallbackPayloadSchema,
      {
        title: "Connect Spotify",
        description: `Authorize Spotify with redirect URI ${redirectUri}. The callback will resume this run automatically.`,
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

    const token = await exchangeSpotifyCode({
      clientId,
      clientSecret,
      code: callback.code,
      redirectUri,
    });
    const profile = await fetchSpotifyProfile(token.access_token);

    return {
      workflow: "spotify",
      action: "read-current-user-profile",
      spotifyUserId: profile.id,
      displayName: profile.display_name ?? profile.id,
      email: profile.email ?? undefined,
      country: profile.country,
      product: profile.product,
      followers: profile.followers?.total,
      profileUrl: profile.external_urls?.spotify,
      grantedScopes: token.scope.split(/\s+/).filter(Boolean),
      tokenExpiresInSeconds: token.expires_in,
    };
  },
  {
    name: "spotifyProfile",
    description:
      "Authorize Spotify, exchange the OAuth code, and read the current user's profile.",
  },
);

export async function createSpotifyOAuthState(
  payload: SpotifyOAuthStatePayload,
  secret: string,
): Promise<string> {
  const signature = await signSpotifyOAuthState(payload, secret);
  return base64UrlEncodeUtf8(JSON.stringify({ ...payload, signature }));
}

export async function readSpotifyOAuthState(
  encodedState: string,
  secret: string,
): Promise<SpotifyOAuthStatePayload> {
  const parsed = spotifyOAuthStateSchema.parse(
    JSON.parse(base64UrlDecodeUtf8(encodedState)),
  );
  const expected = await signSpotifyOAuthState(
    {
      runId: parsed.runId,
      interventionId: parsed.interventionId,
      redirectUri: parsed.redirectUri,
    },
    secret,
  );
  if (!constantTimeEqual(parsed.signature, expected)) {
    throw new Error("Invalid Spotify OAuth state signature.");
  }
  return {
    runId: parsed.runId,
    interventionId: parsed.interventionId,
    redirectUri: parsed.redirectUri,
  };
}

function spotifyCallbackRedirectUri(appBaseUrl: string): string {
  return new URL("/api/spotify/callback", appBaseUrl).toString();
}

function spotifyAuthorizeUrl(args: {
  clientId: string;
  redirectUri: string;
  state: string;
  showDialog: boolean;
}): string {
  const url = new URL("https://accounts.spotify.com/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", args.clientId);
  url.searchParams.set("scope", "user-read-private user-read-email");
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("state", args.state);
  if (args.showDialog) url.searchParams.set("show_dialog", "true");
  return url.toString();
}

async function exchangeSpotifyCode(args: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<z.infer<typeof spotifyTokenResponseSchema>> {
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${base64EncodeUtf8(
        `${args.clientId}:${args.clientSecret}`,
      )}`,
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
      `Spotify token exchange failed (${response.status}): ${await responsePreview(
        response,
      )}`,
    );
  }

  return spotifyTokenResponseSchema.parse(await response.json());
}

async function fetchSpotifyProfile(
  accessToken: string,
): Promise<z.infer<typeof spotifyProfileSchema>> {
  const response = await fetch("https://api.spotify.com/v1/me", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Spotify profile request failed (${response.status}): ${await responsePreview(
        response,
      )}`,
    );
  }

  return spotifyProfileSchema.parse(await response.json());
}

async function responsePreview(response: Response): Promise<string> {
  const text = await response.text();
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

async function signSpotifyOAuthState(
  payload: SpotifyOAuthStatePayload,
  secret: string,
): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Web Crypto is required to sign Spotify OAuth state.");
  }
  const encoder = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await globalThis.crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(stateSigningInput(payload)),
  );
  return base64UrlEncodeBytes(new Uint8Array(signature));
}

function stateSigningInput(payload: SpotifyOAuthStatePayload): string {
  return JSON.stringify({
    interventionId: payload.interventionId,
    redirectUri: payload.redirectUri,
    runId: payload.runId,
  });
}

function defaultAppBaseUrl(): string {
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL;
  if (process.env.PORTLESS_URL) return process.env.PORTLESS_URL;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://127.0.0.1:3000";
}

function base64EncodeUtf8(value: string): string {
  return base64EncodeBytes(new TextEncoder().encode(value));
}

function base64UrlEncodeUtf8(value: string): string {
  return base64UrlEncodeBytes(new TextEncoder().encode(value));
}

function base64UrlDecodeUtf8(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(
    base64.length + ((4 - (base64.length % 4)) % 4),
    "=",
  );
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  return base64EncodeBytes(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64EncodeBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let i = 0; i < left.length; i += 1) {
    mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return mismatch === 0;
}
