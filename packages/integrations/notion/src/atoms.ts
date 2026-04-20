import { type Atom, atom, type Handle } from "@workflow/core";
import { z } from "zod";
import { NOTION_VERSION, type NotionAuth } from "./oauth";

export type NotionPage = {
  id: string;
  url?: string;
  archived?: boolean;
  raw: unknown;
};

export type GetPageOptions = {
  auth: Atom<NotionAuth>;
  pageId: Handle<string>;
  name?: string;
};

const pageResponseSchema = z
  .object({
    id: z.string(),
    url: z.string().optional(),
    archived: z.boolean().optional(),
  })
  .passthrough();

export function getPage(opts: GetPageOptions): Atom<NotionPage> {
  return atom(
    async (get) => {
      const { accessToken } = get(opts.auth);
      const pageId = get(opts.pageId);

      const response = await fetch(
        `https://api.notion.com/v1/pages/${encodeURIComponent(pageId)}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Notion-Version": NOTION_VERSION,
          },
        },
      );
      if (!response.ok) {
        throw new Error(
          `Notion GET /v1/pages/${pageId} failed (${response.status}): ${await response.text()}`,
        );
      }
      const raw = await response.json();
      const parsed = pageResponseSchema.parse(raw);
      return {
        id: parsed.id,
        url: parsed.url,
        archived: parsed.archived,
        raw,
      };
    },
    { name: opts.name ?? "notionGetPage" },
  );
}
