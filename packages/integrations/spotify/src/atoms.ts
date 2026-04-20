import { type Atom, atom } from "@workflow/core";
import { z } from "zod";
import type { SpotifyAuth } from "./oauth";

export type SpotifyProfile = {
  id: string;
  displayName: string | null;
  email: string | null;
  country?: string;
  product?: string;
  followers?: number;
  profileUrl?: string;
};

export type GetCurrentUserOptions = {
  auth: Atom<SpotifyAuth>;
  name?: string;
};

const profileSchema = z
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

export function getCurrentUser(
  opts: GetCurrentUserOptions,
): Atom<SpotifyProfile> {
  return atom(
    async (get) => {
      const { accessToken } = get(opts.auth);
      const response = await fetch("https://api.spotify.com/v1/me", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) {
        throw new Error(
          `Spotify GET /v1/me failed (${response.status}): ${await response.text()}`,
        );
      }
      const body = profileSchema.parse(await response.json());
      return {
        id: body.id,
        displayName: body.display_name ?? null,
        email: body.email ?? null,
        country: body.country,
        product: body.product,
        followers: body.followers?.total,
        profileUrl: body.external_urls?.spotify,
      };
    },
    { name: opts.name ?? "spotifyGetCurrentUser" },
  );
}
