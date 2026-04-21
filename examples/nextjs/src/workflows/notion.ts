import { atom, input } from "@workflow/core";
import { createPage, getPage, notion } from "@workflow/integrations-notion";
import { z } from "zod";

// ── Workflow 1: Log a page in Notion ─────────────────────────────────────────
// input → notion connection (auto OAuth) → createPage (action).

export const notionLogRequest = input(
  "notionLogRequest",
  z.object({
    parentPageId: z.string().default(process.env.NOTION_PARENT_PAGE_ID ?? ""),
    title: z.string().default("Workflow log entry"),
    body: z.string().default("Logged from a Hylo workflow run."),
  }),
  {
    title: "Create a Notion page",
    description:
      "Authorize Notion and create a new page under the provided parent. Defaults the parent to NOTION_PARENT_PAGE_ID.",
  },
);

const notionLogTitle = atom((get) => get(notionLogRequest).title, {
  name: "notionLogTitle",
});
const notionLogBody = atom((get) => get(notionLogRequest).body, {
  name: "notionLogBody",
});
const notionLogParent = atom((get) => get(notionLogRequest).parentPageId, {
  name: "notionLogParent",
});

export const notionLogPage = createPage({
  auth: notion,
  parentPageId: notionLogParent,
  title: notionLogTitle,
  body: notionLogBody,
  actionName: "notionLogPage",
});

// ── Workflow 2: Fetch a Notion page ──────────────────────────────────────────
// input → notion connection (auto OAuth) → getPage (atom). Pure read pipeline.

export const notionFetchRequest = input(
  "notionFetchRequest",
  z.object({
    pageId: z.string().default(process.env.NOTION_PAGE_ID ?? ""),
  }),
  {
    title: "Fetch a Notion page",
    description:
      "Authorize Notion and fetch a page by ID. Defaults the pageId to NOTION_PAGE_ID.",
  },
);

const notionFetchPageId = atom((get) => get(notionFetchRequest).pageId, {
  name: "notionFetchPageId",
});

export const notionFetchedPage = getPage({
  auth: notion,
  pageId: notionFetchPageId,
  name: "notionFetchedPage",
});
