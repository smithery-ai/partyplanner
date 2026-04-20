import { atom, input, secret } from "@workflow/core";
import {
  createPage,
  getPage,
  notionOAuth,
} from "@workflow/integrations-notion";
import { z } from "zod";
import { oauthStateSecret } from "./spotify";

function defaultAppBaseUrl(): string {
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL;
  if (process.env.PORTLESS_URL) return process.env.PORTLESS_URL;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://127.0.0.1:3000";
}

export const notionClientId = secret(
  "NOTION_CLIENT_ID",
  process.env.NOTION_CLIENT_ID,
  {
    description: "Notion OAuth integration client ID.",
    errorMessage: "Set NOTION_CLIENT_ID in the Next.js environment.",
  },
);

export const notionClientSecret = secret(
  "NOTION_CLIENT_SECRET",
  process.env.NOTION_CLIENT_SECRET,
  {
    description: "Notion OAuth integration client secret.",
    errorMessage: "Set NOTION_CLIENT_SECRET in the Next.js environment.",
  },
);

// ── Workflow 1: Log a page in Notion ─────────────────────────────────────────
// input → notionOAuth (atom) → createPage (action). All three node kinds.

export const notionLogRequest = input(
  "notionLogRequest",
  z.object({
    appBaseUrl: z.string().url().default(defaultAppBaseUrl()),
    parentPageId: z.string().default(process.env.NOTION_PARENT_PAGE_ID ?? ""),
    title: z.string().default("Workflow log entry"),
    body: z.string().default("Logged from a Hylo workflow run."),
  }),
  {
    description:
      "Authorize Notion and create a new page under the provided parent. Defaults the parent to NOTION_PARENT_PAGE_ID.",
  },
);

const notionLogAuth = notionOAuth({
  login: notionLogRequest,
  clientId: notionClientId,
  clientSecret: notionClientSecret,
  stateSecret: oauthStateSecret,
  name: "notionLogAuth",
});

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
  auth: notionLogAuth,
  parentPageId: notionLogParent,
  title: notionLogTitle,
  body: notionLogBody,
  actionName: "notionLogPage",
});

// ── Workflow 2: Fetch a Notion page ──────────────────────────────────────────
// input → notionOAuth (atom) → getPage (atom). No action — pure read pipeline.

export const notionFetchRequest = input(
  "notionFetchRequest",
  z.object({
    appBaseUrl: z.string().url().default(defaultAppBaseUrl()),
    pageId: z.string().default(process.env.NOTION_PAGE_ID ?? ""),
  }),
  {
    description:
      "Authorize Notion and fetch a page by ID. Defaults the pageId to NOTION_PAGE_ID.",
  },
);

const notionFetchAuth = notionOAuth({
  login: notionFetchRequest,
  clientId: notionClientId,
  clientSecret: notionClientSecret,
  stateSecret: oauthStateSecret,
  name: "notionFetchAuth",
});

const notionFetchPageId = atom((get) => get(notionFetchRequest).pageId, {
  name: "notionFetchPageId",
});

export const notionFetchedPage = getPage({
  auth: notionFetchAuth,
  pageId: notionFetchPageId,
  name: "notionFetchedPage",
});
