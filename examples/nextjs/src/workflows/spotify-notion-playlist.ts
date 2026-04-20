import { atom, input } from "@workflow/core";
import {
  NOTION_VERSION,
  type NotionBlock,
  notionOAuth,
} from "@workflow/integrations-notion";
import {
  getCurrentUserPlaylists,
  getPlaylistTracks,
  type SpotifyPlaylistSummary,
  type SpotifyPlaylistTrack,
  spotifyOAuth,
} from "@workflow/integrations-spotify";
import { z } from "zod";
import { notionClientId, notionClientSecret } from "./notion";
import {
  oauthStateSecret,
  spotifyClientId,
  spotifyClientSecret,
} from "./spotify";

export const spotifyPlaylistAnalysisRequest = input(
  "spotifyPlaylistAnalysisRequest",
  z.object({
    appBaseUrl: z.string().url().default(defaultAppBaseUrl()),
    notionParentPageId: z
      .string()
      .default(process.env.NOTION_PARENT_PAGE_ID ?? "")
      .describe(
        "The Notion page ID where the playlist document should be created.",
      ),
    notionPageTitle: z
      .string()
      .default("Spotify playlist analysis")
      .describe(
        "Use the default to title the page with the selected playlist name.",
      ),
    showDialog: z
      .boolean()
      .default(false)
      .describe("Ask Spotify to show the account picker during authorization."),
  }),
  {
    title: "Analyse a Spotify playlist into Notion",
    description:
      "Connect Spotify and Notion, choose one of your playlists, then create a Notion page containing the playlist analysis and every song.",
  },
);

const spotifyPlaylistAnalysisAuth = spotifyOAuth({
  login: spotifyPlaylistAnalysisRequest,
  clientId: spotifyClientId,
  clientSecret: spotifyClientSecret,
  stateSecret: oauthStateSecret,
  scopes: [
    "user-read-private",
    "user-read-email",
    "playlist-read-private",
    "playlist-read-collaborative",
  ],
  name: "spotifyPlaylistAnalysisAuth",
});

const spotifyPlaylistAnalysisPlaylists = getCurrentUserPlaylists({
  auth: spotifyPlaylistAnalysisAuth,
  name: "spotifyPlaylistAnalysisPlaylists",
});

const spotifyPlaylistSelection = atom(
  (get, requestIntervention) => {
    const playlists = get(spotifyPlaylistAnalysisPlaylists);
    if (playlists.length === 0) {
      return get.skip("Spotify returned no playlists for this account.");
    }

    const choices = playlistChoices(playlists);
    const response = requestIntervention(
      "choose-playlist",
      z.object({
        playlistName: z
          .enum(choices.map((choice) => choice.label) as [string, ...string[]])
          .describe("Choose the playlist to analyse."),
      }),
      {
        title: "Choose a Spotify playlist",
        description: `Fetched ${playlists.length} playlists from Spotify. Pick a playlist by name; duplicate names include owner and Spotify ID so the agent can map your choice to the right playlist.`,
      },
    );

    const match = choices.find(
      (choice) => choice.label === response.playlistName,
    );
    if (!match) {
      throw new Error(`Unknown Spotify playlist: ${response.playlistName}`);
    }
    return match.playlist;
  },
  {
    name: "spotifyPlaylistSelection",
    description:
      "Ask the user which Spotify playlist to analyse, then map that choice to a Spotify playlist ID.",
  },
);

const spotifyPlaylistId = atom((get) => get(spotifyPlaylistSelection).id, {
  name: "spotifyPlaylistId",
});

const spotifyPlaylistName = atom((get) => get(spotifyPlaylistSelection).name, {
  name: "spotifyPlaylistName",
});

const spotifyPlaylistAnalysisTracks = getPlaylistTracks({
  auth: spotifyPlaylistAnalysisAuth,
  playlistId: spotifyPlaylistId,
  playlistName: spotifyPlaylistName,
  name: "spotifyPlaylistAnalysisTracks",
});

const spotifyPlaylistAnalysis = atom(
  (get) => {
    const playlist = get(spotifyPlaylistSelection);
    const playlistTracks = get(spotifyPlaylistAnalysisTracks);
    const totalDurationMs = playlistTracks.tracks.reduce(
      (sum, track) => sum + (track.durationMs ?? 0),
      0,
    );
    const artistCounts = new Map<string, number>();
    let localTrackCount = 0;

    for (const track of playlistTracks.tracks) {
      if (track.isLocal) localTrackCount += 1;
      for (const artist of track.artists) {
        artistCounts.set(artist, (artistCounts.get(artist) ?? 0) + 1);
      }
    }

    const topArtists = [...artistCounts.entries()]
      .sort(
        (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
      )
      .slice(0, 10)
      .map(([name, count]) => ({ name, count }));

    return {
      playlistId: playlist.id,
      playlistName: playlist.name,
      trackCount: playlistTracks.tracks.length,
      totalDurationMs,
      localTrackCount,
      uniqueArtistCount: artistCounts.size,
      topArtists,
    };
  },
  {
    name: "spotifyPlaylistAnalysis",
    description:
      "Summarize the selected Spotify playlist before writing it to Notion.",
  },
);

const notionPlaylistParentPageId = atom(
  (get) => get(spotifyPlaylistAnalysisRequest).notionParentPageId,
  { name: "notionPlaylistParentPageId" },
);

const notionPlaylistPageTitle = atom(
  (get) => {
    const request = get(spotifyPlaylistAnalysisRequest);
    const playlist = get(spotifyPlaylistSelection);
    if (
      request.notionPageTitle &&
      request.notionPageTitle !== "Spotify playlist analysis"
    ) {
      return request.notionPageTitle;
    }
    return `Spotify playlist analysis: ${playlist.name}`;
  },
  { name: "notionPlaylistPageTitle" },
);

const notionPlaylistPageBlocks = atom(
  (get) => {
    const playlist = get(spotifyPlaylistSelection);
    const playlistTracks = get(spotifyPlaylistAnalysisTracks);
    const analysis = get(spotifyPlaylistAnalysis);

    const blocks: NotionBlock[] = [
      heading("Playlist"),
      paragraph(`Name: ${playlist.name}`),
      paragraph(`Spotify playlist ID: ${playlist.id}`),
      paragraph(
        `Spotify URL: ${playlist.externalUrl ?? "Unavailable"}`,
        playlist.externalUrl,
      ),
      heading("Analysis"),
      bulletedListItem(`Tracks: ${analysis.trackCount}`),
      bulletedListItem(
        `Total duration: ${formatDuration(analysis.totalDurationMs)}`,
      ),
      bulletedListItem(`Unique artists: ${analysis.uniqueArtistCount}`),
      bulletedListItem(`Local files: ${analysis.localTrackCount}`),
      bulletedListItem(
        `Top artists: ${
          analysis.topArtists
            .map((artist) => `${artist.name} (${artist.count})`)
            .join(", ") || "None"
        }`,
      ),
      heading("Songs"),
    ];

    if (playlistTracks.tracks.length === 0) {
      blocks.push(paragraph("Spotify returned no tracks for this playlist."));
      return blocks;
    }

    for (const track of playlistTracks.tracks) {
      blocks.push(numberedListItem(formatTrack(track), track.externalUrl));
    }

    return blocks;
  },
  {
    name: "notionPlaylistPageBlocks",
    description:
      "Build the Notion blocks for the playlist summary and complete song list.",
  },
);

const notionPlaylistAnalysisAuth = notionOAuth({
  login: spotifyPlaylistAnalysisRequest,
  clientId: notionClientId,
  clientSecret: notionClientSecret,
  stateSecret: oauthStateSecret,
  waitFor: notionPlaylistPageBlocks,
  name: "notionPlaylistAnalysisAuth",
});

const notionPageResponseSchema = z
  .object({
    id: z.string(),
    url: z.string().optional(),
    archived: z.boolean().optional(),
  })
  .passthrough();

const spotifyPlaylistNotionPage = atom(
  async (get) => {
    const parentPageId = get(notionPlaylistParentPageId);
    const title = get(notionPlaylistPageTitle);
    const children = get(notionPlaylistPageBlocks);
    const { accessToken } = get(notionPlaylistAnalysisAuth);

    return createNotionPage({
      accessToken,
      parentPageId,
      title,
      children,
    });
  },
  {
    name: "spotifyPlaylistNotionPage",
    description:
      "Create the Notion page containing the selected Spotify playlist.",
  },
);

export const spotifyPlaylistNotionResult = atom(
  (get) => {
    const request = get.maybe(spotifyPlaylistAnalysisRequest);
    if (!request)
      return get.skip("No Spotify playlist analysis was requested.");

    const playlist = get(spotifyPlaylistSelection);
    const analysis = get(spotifyPlaylistAnalysis);
    const page = get(spotifyPlaylistNotionPage);

    return {
      workflow: "spotify-playlist-notion",
      action: "created-notion-playlist-analysis",
      playlistId: playlist.id,
      playlistName: playlist.name,
      trackCount: analysis.trackCount,
      notionPageId: page.id,
      notionUrl: page.url,
    };
  },
  {
    name: "spotifyPlaylistNotionResult",
    description:
      "Create the Notion playlist analysis page and return the completed result.",
  },
);

function playlistChoices(playlists: SpotifyPlaylistSummary[]): {
  label: string;
  playlist: SpotifyPlaylistSummary;
}[] {
  const nameCounts = playlists.reduce((counts, playlist) => {
    counts.set(playlist.name, (counts.get(playlist.name) ?? 0) + 1);
    return counts;
  }, new Map<string, number>());

  return playlists.map((playlist) => {
    const duplicateName = (nameCounts.get(playlist.name) ?? 0) > 1;
    const label = duplicateName
      ? `${playlist.name} (${playlist.ownerDisplayName ?? "unknown owner"}, ${playlist.trackCount ?? "unknown"} tracks, ${playlist.id})`
      : playlist.name;
    return { label, playlist };
  });
}

function heading(content: string): NotionBlock {
  return {
    object: "block",
    type: "heading_2",
    heading_2: { rich_text: richText(content) },
  };
}

function paragraph(content: string, url?: string): NotionBlock {
  return {
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: richText(content, url) },
  };
}

function bulletedListItem(content: string): NotionBlock {
  return {
    object: "block",
    type: "bulleted_list_item",
    bulleted_list_item: { rich_text: richText(content) },
  };
}

function numberedListItem(content: string, url?: string): NotionBlock {
  return {
    object: "block",
    type: "numbered_list_item",
    numbered_list_item: { rich_text: richText(content, url) },
  };
}

async function createNotionPage(args: {
  accessToken: string;
  parentPageId: string;
  title: string;
  children: NotionBlock[];
}) {
  const response = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      "Content-Type": "application/json",
      "Notion-Version": NOTION_VERSION,
    },
    body: JSON.stringify({
      parent: { page_id: args.parentPageId },
      properties: {
        title: {
          title: [{ type: "text", text: { content: args.title } }],
        },
      },
      children:
        args.children.length > 0 ? args.children.slice(0, 100) : undefined,
    }),
  });
  if (!response.ok) {
    throw new Error(
      `Notion POST /v1/pages failed (${response.status}): ${await response.text()}`,
    );
  }

  const raw = await response.json();
  const parsed = notionPageResponseSchema.parse(raw);
  for (const blockChunk of chunks(args.children.slice(100), 100)) {
    await appendNotionBlocks({
      accessToken: args.accessToken,
      blockId: parsed.id,
      children: blockChunk,
    });
  }

  return {
    id: parsed.id,
    url: parsed.url,
    archived: parsed.archived,
    raw,
  };
}

async function appendNotionBlocks(args: {
  accessToken: string;
  blockId: string;
  children: NotionBlock[];
}): Promise<void> {
  const response = await fetch(
    `https://api.notion.com/v1/blocks/${encodeURIComponent(args.blockId)}/children`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${args.accessToken}`,
        "Content-Type": "application/json",
        "Notion-Version": NOTION_VERSION,
      },
      body: JSON.stringify({ children: args.children }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Notion PATCH /v1/blocks/:id/children failed (${response.status}): ${await response.text()}`,
    );
  }
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function richText(content: string, url?: string): Record<string, unknown>[] {
  return [
    {
      type: "text",
      text: {
        content: truncate(content, 1800),
        ...(url ? { link: { url } } : {}),
      },
    },
  ];
}

function formatTrack(track: SpotifyPlaylistTrack): string {
  const artists =
    track.artists.length > 0 ? track.artists.join(", ") : "Unknown artist";
  const album = track.album ? ` (${track.album})` : "";
  const local = track.isLocal ? " [local file]" : "";
  return `${track.name} - ${artists}${album}${local}`;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "Unknown";
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}

function defaultAppBaseUrl(): string {
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL;
  if (process.env.PORTLESS_URL) return process.env.PORTLESS_URL;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://127.0.0.1:3000";
}
