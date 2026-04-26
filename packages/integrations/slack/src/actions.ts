import {
  type Action,
  type Atom,
  action,
  type Get,
  type Handle,
  isHandle,
} from "@workflow/core";
import { z } from "zod";
import { parseSlackApiResponse } from "./api";
import type { SlackAuth } from "./oauth";

export type SlackMessage = {
  channel: string;
  channelId?: string;
  ts: string;
  threadTs?: string;
  text?: string;
  raw?: unknown;
};

export type SlackBlock = Record<string, unknown>;
type MaybeHandle<T> = Handle<T> | T;

export type PostMessageOptions = {
  auth: Atom<SlackAuth>;
  channel: MaybeHandle<string>;
  text: MaybeHandle<string>;
  threadTs?: MaybeHandle<string | undefined>;
  blocks?: MaybeHandle<SlackBlock[] | undefined>;
  actionName?: string;
};

const postMessageResponseSchema = z
  .object({
    ok: z.literal(true),
    channel: z.string().optional(),
    ts: z.string(),
    message: z
      .object({
        text: z.string().optional(),
        thread_ts: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export function postMessage(opts: PostMessageOptions): Action<SlackMessage> {
  return action(
    async (get) => {
      const { accessToken } = get(opts.auth);
      const channel = resolve(get, opts.channel);
      const text = resolve(get, opts.text);
      const threadTs = resolveOptional(get, opts.threadTs);
      const blocks = resolveOptional(get, opts.blocks);

      const response = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          channel,
          text,
          ...(threadTs ? { thread_ts: threadTs } : {}),
          ...(blocks ? { blocks } : {}),
        }),
      });

      const body = await parseSlackApiResponse(
        response,
        postMessageResponseSchema,
        "chat.postMessage",
      );
      const posted: SlackMessage = {
        channel,
        channelId: body.channel,
        ts: body.ts,
        text: body.message?.text,
      };
      const resolvedThreadTs = body.message?.thread_ts ?? threadTs;
      if (resolvedThreadTs) posted.threadTs = resolvedThreadTs;
      return posted;
    },
    { name: opts.actionName ?? "slackPostMessage" },
  );
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
