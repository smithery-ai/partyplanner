import {
  type Atom,
  atom,
  type Get,
  type Handle,
  isHandle,
} from "@workflow/core";
import { z } from "zod";
import { parseSlackApiResponse } from "./api";
import type { SlackAuth } from "./oauth";
import {
  type SlackWebhookPayload,
  slackEventCallbackPayloadSchema,
  slackProviderWebhookPayloadSchema,
  slackWebhookEnvelopeSchema,
} from "./webhooks";

type MaybeHandle<T> = Handle<T> | T;

export type SlackConversationMessage = {
  channel: string;
  ts: string;
  threadTs?: string;
  user?: string;
  botId?: string;
  type?: string;
  text?: string;
  raw: unknown;
};

export type SlackConversationMessages = {
  channel: string;
  messages: SlackConversationMessage[];
  hasMore?: boolean;
  raw: unknown[];
};

export type SlackReceivedMessage = {
  kind: string;
  channel: string;
  ts: string;
  threadTs: string;
  user?: string;
  botId?: string;
  subtype?: string;
  text?: string;
  raw: unknown;
};

export type SlackMessageLookupOptions = {
  auth: Atom<SlackAuth>;
  channel: MaybeHandle<string>;
  limit?: MaybeHandle<number>;
  latest?: MaybeHandle<string | undefined>;
  oldest?: MaybeHandle<string | undefined>;
  inclusive?: MaybeHandle<boolean | undefined>;
  name?: string;
};

export type GetThreadMessagesOptions = SlackMessageLookupOptions & {
  threadTs: MaybeHandle<string>;
  maxPages?: MaybeHandle<number>;
};

export type SlackMessageFromWebhookOptions = {
  webhook: Handle<SlackWebhookPayload | { payload: SlackWebhookPayload }>;
  name?: string;
};

const messageSchema = z
  .object({
    type: z.string().optional(),
    user: z.string().optional(),
    bot_id: z.string().optional(),
    ts: z.string(),
    thread_ts: z.string().optional(),
    text: z.string().optional(),
  })
  .passthrough();

const messagePageSchema = z
  .object({
    ok: z.literal(true),
    messages: z.array(messageSchema),
    has_more: z.boolean().optional(),
    response_metadata: z
      .object({
        next_cursor: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export function messageFromWebhook(
  opts: SlackMessageFromWebhookOptions,
): Atom<SlackReceivedMessage> {
  return atom(
    (get) => {
      const webhook = normalizeWebhookPayload(get(opts.webhook));
      if (webhook.kind !== "event_callback") {
        return get.skip(`Slack webhook kind is not event_callback`);
      }

      const payload = slackEventCallbackPayloadSchema.parse(webhook.payload);
      const event = payload.event;
      const ts = event.ts ?? event.event_ts;
      if (!event.channel || !ts) {
        return get.skip("Slack event is missing channel or timestamp");
      }

      return {
        kind: event.type,
        channel: event.channel,
        ts,
        threadTs: event.thread_ts ?? ts,
        user: event.user,
        botId: event.bot_id,
        subtype: event.subtype,
        text: event.text,
        raw: event,
      };
    },
    {
      name: opts.name ?? "slackMessageFromWebhook",
      description: "Extract the Slack message event from a Hylo Slack webhook.",
    },
  );
}

function normalizeWebhookPayload(value: unknown): SlackWebhookPayload {
  const direct = slackProviderWebhookPayloadSchema.safeParse(value);
  if (direct.success) return direct.data;
  return slackWebhookEnvelopeSchema.parse(value).payload;
}

export function getChannelMessages(
  opts: SlackMessageLookupOptions,
): Atom<SlackConversationMessages> {
  return atom(
    async (get) => {
      const { accessToken } = get(opts.auth);
      const channel = resolve(get, opts.channel);
      const limit = normalizedLimit(resolveOptional(get, opts.limit) ?? 10);
      const url = slackApiUrl("conversations.history", {
        channel,
        limit: String(limit),
        latest: resolveOptional(get, opts.latest),
        oldest: resolveOptional(get, opts.oldest),
        inclusive: resolveOptional(get, opts.inclusive),
      });
      const page = await fetchSlackMessages(url, accessToken);
      return {
        channel,
        messages: page.messages.map((message) =>
          toConversationMessage(channel, message),
        ),
        hasMore: page.has_more,
        raw: [page],
      };
    },
    {
      name: opts.name ?? "slackGetChannelMessages",
      description: "Fetch recent messages from a Slack channel.",
    },
  );
}

export function getThreadMessages(
  opts: GetThreadMessagesOptions,
): Atom<SlackConversationMessages> {
  return atom(
    async (get) => {
      const { accessToken } = get(opts.auth);
      const channel = resolve(get, opts.channel);
      const threadTs = resolve(get, opts.threadTs);
      const limit = normalizedLimit(resolveOptional(get, opts.limit) ?? 10);
      const maxPages = Math.max(
        1,
        Math.min(20, Math.floor(resolveOptional(get, opts.maxPages) ?? 10)),
      );
      const messages: z.infer<typeof messageSchema>[] = [];
      const raw: unknown[] = [];
      let cursor: string | undefined;
      let hasMore = false;

      for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
        const url = slackApiUrl("conversations.replies", {
          channel,
          ts: threadTs,
          limit: String(Math.max(limit, 100)),
          latest: resolveOptional(get, opts.latest),
          oldest: resolveOptional(get, opts.oldest),
          inclusive: resolveOptional(get, opts.inclusive),
          cursor,
        });
        const page = await fetchSlackMessages(url, accessToken);
        raw.push(page);
        messages.push(...page.messages);
        cursor = page.response_metadata?.next_cursor || undefined;
        hasMore = page.has_more === true || Boolean(cursor);
        if (!cursor) break;
      }

      return {
        channel,
        messages: messages
          .sort((a, b) => Number(a.ts) - Number(b.ts))
          .slice(-limit)
          .map((message) => toConversationMessage(channel, message)),
        hasMore,
        raw,
      };
    },
    {
      name: opts.name ?? "slackGetThreadMessages",
      description: "Fetch messages from a Slack thread.",
    },
  );
}

async function fetchSlackMessages(
  url: string,
  accessToken: string,
): Promise<z.infer<typeof messagePageSchema>> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return parseSlackApiResponse(response, messagePageSchema, `GET ${url}`);
}

function toConversationMessage(
  channel: string,
  message: z.infer<typeof messageSchema>,
): SlackConversationMessage {
  return {
    channel,
    ts: message.ts,
    threadTs: message.thread_ts,
    user: message.user,
    botId: message.bot_id,
    type: message.type,
    text: message.text,
    raw: message,
  };
}

function slackApiUrl(
  method: "conversations.history" | "conversations.replies",
  params: Record<string, string | number | boolean | undefined>,
): string {
  const url = new URL(`https://slack.com/api/${method}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function normalizedLimit(limit: number): number {
  return Math.max(1, Math.min(1000, Math.floor(limit)));
}

function resolve<T>(get: Get, value: MaybeHandle<T>): T {
  return isHandle(value) ? get(value) : value;
}

function resolveOptional<T>(
  get: Get,
  value: MaybeHandle<T> | undefined,
): T | undefined {
  return value === undefined ? undefined : resolve(get, value);
}
