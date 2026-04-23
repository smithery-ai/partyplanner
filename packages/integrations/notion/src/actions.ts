import { type Action, type Atom, action, type Handle } from "@workflow/core";
import { z } from "zod";
import type { NotionPage } from "./atoms";
import { notionApiError } from "./errors";
import { normalizeNotionId, normalizeNotionParent } from "./ids";
import { NOTION_VERSION, type NotionAuth } from "./oauth";

export type NotionBlock = Record<string, unknown>;

export type CreatePageOptions = {
  auth: Atom<NotionAuth>;
  parentPageId: Handle<string>;
  title: Handle<string>;
  // Optional body text inserted as paragraph blocks.
  body?: Handle<string>;
  children?: Handle<NotionBlock[]>;
  actionName?: string;
};

const pageResponseSchema = z
  .object({
    id: z.string(),
    url: z.string().optional(),
    archived: z.boolean().optional(),
  })
  .passthrough();

export function createPage(opts: CreatePageOptions): Action<NotionPage> {
  return action(
    async (get) => {
      const parent = normalizeNotionParent(get(opts.parentPageId));
      const title = get(opts.title);
      const body = opts.body ? get(opts.body) : undefined;
      const children = opts.children ? get(opts.children) : undefined;
      const { accessToken } = get(opts.auth);

      const pageChildren = [
        ...(body ? textToParagraphBlocks(body) : []),
        ...(children ?? []),
      ];

      const response = await fetch("https://api.notion.com/v1/pages", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "Notion-Version": NOTION_VERSION,
        },
        body: JSON.stringify({
          parent,
          properties: {
            title: {
              title: [{ type: "text", text: { content: title } }],
            },
          },
          children:
            pageChildren.length > 0 ? pageChildren.slice(0, 100) : undefined,
        }),
      });
      if (!response.ok) {
        throw await notionApiError(response, "POST /v1/pages");
      }
      const raw = await response.json();
      const parsed = pageResponseSchema.parse(raw);
      for (const blockChunk of chunks(pageChildren.slice(100), 100)) {
        await appendBlockChildren({
          accessToken,
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
    },
    { name: opts.actionName ?? "notionCreatePage" },
  );
}

function textToParagraphBlocks(body: string): NotionBlock[] {
  const blocks: NotionBlock[] = [];
  for (const paragraph of body.split(/\n{2,}/)) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;
    for (const content of splitText(trimmed, 1800)) {
      blocks.push({
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [{ type: "text", text: { content } }],
        },
      });
    }
  }
  return blocks;
}

function splitText(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    const breakpoint = remaining.lastIndexOf("\n", maxLength);
    const sliceAt = breakpoint > 0 ? breakpoint : maxLength;
    parts.push(remaining.slice(0, sliceAt).trim());
    remaining = remaining.slice(sliceAt).trim();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

async function appendBlockChildren(args: {
  accessToken: string;
  blockId: string;
  children: NotionBlock[];
}): Promise<void> {
  const response = await fetch(
    `https://api.notion.com/v1/blocks/${encodeURIComponent(normalizeNotionId(args.blockId, "Notion block ID"))}/children`,
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
    throw await notionApiError(response, "PATCH /v1/blocks/:id/children");
  }
}
