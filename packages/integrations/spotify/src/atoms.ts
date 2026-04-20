import { type Atom, atom, type Handle } from "@workflow/core";
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

export type SpotifyPlaylistSummary = {
  id: string;
  name: string;
  description?: string;
  ownerDisplayName?: string;
  trackCount?: number;
  public?: boolean | null;
  collaborative?: boolean;
  externalUrl?: string;
};

export type SpotifyPlaylistTrack = {
  position: number;
  id?: string;
  name: string;
  artists: string[];
  album?: string;
  durationMs?: number;
  discNumber?: number;
  trackNumber?: number;
  uri?: string;
  externalUrl?: string;
  isLocal?: boolean;
};

export type SpotifyPlaylistTracks = {
  playlistId: string;
  playlistName?: string;
  total?: number;
  tracks: SpotifyPlaylistTrack[];
};

export type GetCurrentUserOptions = {
  auth: Atom<SpotifyAuth>;
  name?: string;
};

export type GetCurrentUserPlaylistsOptions = {
  auth: Atom<SpotifyAuth>;
  name?: string;
};

export type GetPlaylistTracksOptions = {
  auth: Atom<SpotifyAuth>;
  playlistId: Handle<string>;
  playlistName?: Handle<string>;
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

const playlistPageSchema = z
  .object({
    items: z.array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          description: z.string().nullable().optional(),
          public: z.boolean().nullable().optional(),
          collaborative: z.boolean().optional(),
          tracks: z.object({ total: z.number().optional() }).optional(),
          owner: z
            .object({ display_name: z.string().nullable().optional() })
            .passthrough()
            .optional(),
          external_urls: z
            .object({ spotify: z.string().optional() })
            .optional(),
        })
        .passthrough(),
    ),
    next: z.string().nullable().optional(),
  })
  .passthrough();
type SpotifyPlaylistPage = z.infer<typeof playlistPageSchema>;
type SpotifyPlaylistPageItem = SpotifyPlaylistPage["items"][number];

const playlistTracksPageSchema = z
  .object({
    items: z.array(
      z
        .object({
          track: z
            .object({
              id: z.string().nullable().optional(),
              name: z.string(),
              type: z.string().optional(),
              uri: z.string().optional(),
              is_local: z.boolean().optional(),
              duration_ms: z.number().optional(),
              disc_number: z.number().optional(),
              track_number: z.number().optional(),
              external_urls: z
                .object({ spotify: z.string().optional() })
                .optional(),
              album: z
                .object({ name: z.string().optional() })
                .passthrough()
                .optional(),
              artists: z
                .array(z.object({ name: z.string() }).passthrough())
                .optional(),
            })
            .passthrough()
            .nullable(),
        })
        .passthrough(),
    ),
    next: z.string().nullable().optional(),
    total: z.number().optional(),
  })
  .passthrough();
type SpotifyPlaylistTracksPage = z.infer<typeof playlistTracksPageSchema>;
type SpotifyPlaylistTracksPageItem = SpotifyPlaylistTracksPage["items"][number];

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

export function getCurrentUserPlaylists(
  opts: GetCurrentUserPlaylistsOptions,
): Atom<SpotifyPlaylistSummary[]> {
  return atom(
    async (get) => {
      const { accessToken } = get(opts.auth);
      const playlists: SpotifyPlaylistSummary[] = [];
      let next: string | undefined =
        "https://api.spotify.com/v1/me/playlists?limit=50";

      while (next) {
        const page: SpotifyPlaylistPage =
          await fetchSpotifyJson<SpotifyPlaylistPage>(
            next,
            accessToken,
            playlistPageSchema,
          );
        playlists.push(
          ...page.items.map(
            (playlist: SpotifyPlaylistPageItem): SpotifyPlaylistSummary => ({
              id: playlist.id,
              name: playlist.name,
              description: playlist.description ?? undefined,
              ownerDisplayName: playlist.owner?.display_name ?? undefined,
              trackCount: playlist.tracks?.total,
              public: playlist.public,
              collaborative: playlist.collaborative,
              externalUrl: playlist.external_urls?.spotify,
            }),
          ),
        );
        next = page.next ?? undefined;
      }

      return playlists;
    },
    {
      name: opts.name ?? "spotifyGetCurrentUserPlaylists",
      description: "List the current Spotify user's playlists.",
    },
  );
}

export function getPlaylistTracks(
  opts: GetPlaylistTracksOptions,
): Atom<SpotifyPlaylistTracks> {
  return atom(
    async (get) => {
      const { accessToken } = get(opts.auth);
      const playlistId = get(opts.playlistId);
      const playlistName = opts.playlistName
        ? get.maybe(opts.playlistName)
        : undefined;
      const tracks: SpotifyPlaylistTrack[] = [];
      let total: number | undefined;
      let next: string | undefined =
        `https://api.spotify.com/v1/playlists/${encodeURIComponent(
          playlistId,
        )}/tracks?limit=100&additional_types=track`;

      while (next) {
        const page: SpotifyPlaylistTracksPage =
          await fetchSpotifyJson<SpotifyPlaylistTracksPage>(
            next,
            accessToken,
            playlistTracksPageSchema,
          );
        total ??= page.total;
        for (const item of page.items as SpotifyPlaylistTracksPageItem[]) {
          const track = item.track;
          if (!track || (track.type && track.type !== "track")) continue;
          tracks.push({
            position: tracks.length + 1,
            id: track.id ?? undefined,
            name: track.name,
            artists: track.artists?.map((artist) => artist.name) ?? [],
            album: track.album?.name,
            durationMs: track.duration_ms,
            discNumber: track.disc_number,
            trackNumber: track.track_number,
            uri: track.uri,
            externalUrl: track.external_urls?.spotify,
            isLocal: track.is_local,
          });
        }
        next = page.next ?? undefined;
      }

      return {
        playlistId,
        playlistName,
        total,
        tracks,
      };
    },
    {
      name: opts.name ?? "spotifyGetPlaylistTracks",
      description: "Read every track in a Spotify playlist.",
    },
  );
}

async function fetchSpotifyJson<T>(
  url: string,
  accessToken: string,
  schema: z.ZodSchema<T>,
): Promise<T> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(
      `Spotify GET ${new URL(url).pathname} failed (${response.status}): ${await response.text()}`,
    );
  }
  return schema.parse(await response.json());
}
