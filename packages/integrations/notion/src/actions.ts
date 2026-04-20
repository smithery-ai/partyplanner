import { type Action, type Atom, action, type Handle } from "@workflow/core";
import { z } from "zod";
import type { NotionPage } from "./atoms";
import { NOTION_VERSION, type NotionAuth } from "./oauth";

export type CreatePageOptions = {
  auth: Atom<NotionAuth>;
  parentPageId: Handle<string>;
  title: Handle<string>;
  // Optional body text inserted as a single paragraph block.
  body?: Handle<string>;
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
      const { accessToken } = get(opts.auth);
      const parentPageId = get(opts.parentPageId);
      const title = get(opts.title);
      const body = opts.body ? get.maybe(opts.body) : undefined;

      const children = body
        ? [
            {
              object: "block",
              type: "paragraph",
              paragraph: {
                rich_text: [{ type: "text", text: { content: body } }],
              },
            },
          ]
        : undefined;

      const response = await fetch("https://api.notion.com/v1/pages", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "Notion-Version": NOTION_VERSION,
        },
        body: JSON.stringify({
          parent: { page_id: parentPageId },
          properties: {
            title: {
              title: [{ type: "text", text: { content: title } }],
            },
          },
          children,
        }),
      });
      if (!response.ok) {
        throw new Error(
          `Notion POST /v1/pages failed (${response.status}): ${await response.text()}`,
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
    { name: opts.actionName ?? "notionCreatePage" },
  );
}
