import { atom, input } from "@workflow/core";
import { createPage, getPage, notion } from "@workflow/integrations-notion";
import { z } from "zod";

// Workflow 1: create a page under a parent page.
// input → notion connection (brokered OAuth) → createPage (action) → result atom.

export const notionLogRequest = input(
  "notionLogRequest",
  z.object({
    parentPageId: z.string(),
    title: z.string(),
    body: z.string(),
  }),
  {
    title: "Create a Notion page",
    description:
      "Authorize Notion and create a new page under the provided parent page ID, page URL, slug, or database URL.",
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

export const notionCreatedPage = atom((get) => get(notionLogPage), {
  name: "notionCreatedPage",
  description: "Create the Notion page and expose the created page response.",
});

// Workflow 2: fetch a page by ID.
// input → notion connection (brokered OAuth) → getPage (atom).

export const notionFetchRequest = input(
  "notionFetchRequest",
  z.object({
    pageId: z.string(),
  }),
  {
    title: "Fetch a Notion page",
    description: "Authorize Notion and fetch a page by ID, URL, or slug.",
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
