import { type Action, type Atom, action, type Handle } from "@workflow/core";
import { z } from "zod";
import type { SpotifyProfile } from "./atoms";
import type { SpotifyAuth } from "./oauth";

export type SpotifyPlaylist = {
  id: string;
  name: string;
  externalUrl?: string;
};

export type CreatePlaylistOptions = {
  auth: Atom<SpotifyAuth>;
  profile: Atom<SpotifyProfile>;
  // The playlist name can come from any handle — an input, an atom, or a constant via input().
  name: Handle<string>;
  description?: Handle<string>;
  isPublic?: Handle<boolean>;
  actionName?: string;
};

const playlistResponseSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    external_urls: z.object({ spotify: z.string().optional() }).optional(),
  })
  .passthrough();

export function createPlaylist(
  opts: CreatePlaylistOptions,
): Action<SpotifyPlaylist> {
  return action(
    async (get) => {
      const { accessToken } = get(opts.auth);
      const profile = get(opts.profile);
      const name = get(opts.name);
      const description = opts.description
        ? get.maybe(opts.description)
        : undefined;
      const isPublic = opts.isPublic ? get.maybe(opts.isPublic) : undefined;

      const response = await fetch(
        `https://api.spotify.com/v1/users/${encodeURIComponent(profile.id)}/playlists`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name,
            description: description ?? undefined,
            public: isPublic ?? false,
          }),
        },
      );
      if (!response.ok) {
        throw new Error(
          `Spotify POST /v1/users/:id/playlists failed (${response.status}): ${await response.text()}`,
        );
      }
      const body = playlistResponseSchema.parse(await response.json());
      return {
        id: body.id,
        name: body.name,
        externalUrl: body.external_urls?.spotify,
      };
    },
    { name: opts.actionName ?? "spotifyCreatePlaylist" },
  );
}
