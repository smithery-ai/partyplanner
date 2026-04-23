import {
  createConnection,
  type OAuthProviderSpec,
} from "@workflow/integrations-oauth";
import { z } from "zod";

export type SpotifyAuth = {
  accessToken: string;
  tokenType: string;
  scopes: string[];
  expiresInSeconds: number;
  refreshToken?: string;
  brokerSessionId?: string;
};

// Token shape delivered to worker code. Used by the package's pre-built
// `spotify` connection atom to parse the broker's intervention payload.
export const spotifyAuthSchema: z.ZodType<SpotifyAuth> = z.object({
  accessToken: z.string(),
  tokenType: z.string(),
  scopes: z.array(z.string()),
  expiresInSeconds: z.number(),
  refreshToken: z.string().optional(),
  brokerSessionId: z.string().optional(),
});

const rawTokenSchema = z
  .object({
    access_token: z.string(),
    token_type: z.string(),
    scope: z.string().default(""),
    expires_in: z.number(),
    refresh_token: z.string().optional(),
  })
  .passthrough();

// Provider spec consumed by the OAuth broker on the backend. Worker code
// does not import this; the backend uses it to register the curated Spotify
// connector. The spec contains no
// credentials; client_id/secret are fetched from the backend's secret store.
export const spotifyProvider: OAuthProviderSpec<SpotifyAuth> = {
  id: "spotify",
  authorizeUrl: "https://accounts.spotify.com/authorize",
  tokenUrl: "https://accounts.spotify.com/api/token",
  defaultScopes: ["user-read-private", "user-read-email"],
  tokenSchema: spotifyAuthSchema,
  shapeToken: (raw) => {
    const parsed = rawTokenSchema.parse(raw);
    return {
      accessToken: parsed.access_token,
      tokenType: parsed.token_type,
      scopes: parsed.scope.split(/\s+/).filter(Boolean),
      expiresInSeconds: parsed.expires_in,
      refreshToken: parsed.refresh_token,
    };
  },
};

// Pre-built brokered connection. Import this in worker code:
//   import { spotify } from "@workflow/integrations-spotify";
//   const profile = atom(async (get) => {
//     const { accessToken } = get(spotify);
//     ...
//   });
//
// To override scopes or pass per-run extras, declare your own:
//   export const spotifyForPlaylists = createConnection({
//     providerId: "spotify",
//     tokenSchema: spotifyAuthSchema,
//     scopes: [...],
//     extra: somePerRunExtrasAtom,
//     name: "spotifyForPlaylists",
//   });
export const spotify = createConnection({
  providerId: "spotify",
  tokenSchema: spotifyAuthSchema,
  name: "spotify",
});
