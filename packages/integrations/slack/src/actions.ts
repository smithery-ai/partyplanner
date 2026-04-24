import { type Action, type Atom, action, type Handle } from "@workflow/core";
import { z } from "zod";
import type { SlackAuth } from "./oauth";

export type SlackMessage = {
  channel: string;
  channelId?: string;
  ts: string;
  text?: string;
};

export type PostMessageOptions = {
  auth: Atom<SlackAuth>;
  channel: Handle<string>;
  text: Handle<string>;
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
      })
      .optional(),
  })
  .passthrough();

const postMessageErrorSchema = z
  .object({
    ok: z.literal(false),
    error: z.string(),
  })
  .passthrough();

export function postMessage(opts: PostMessageOptions): Action<SlackMessage> {
  return action(
    async (get) => {
      const { accessToken } = get(opts.auth);
      const channel = get(opts.channel);
      const text = get(opts.text);

      const response = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          channel,
          text,
        }),
      });

      const raw = await response.json();
      if (!response.ok) {
        throw new Error(
          `Slack chat.postMessage failed (${response.status}): ${JSON.stringify(raw)}`,
        );
      }

      const apiError = postMessageErrorSchema.safeParse(raw);
      if (apiError.success) {
        throw new Error(
          `Slack chat.postMessage failed: ${apiError.data.error}`,
        );
      }

      const body = postMessageResponseSchema.parse(raw);
      return {
        channel,
        channelId: body.channel,
        ts: body.ts,
        text: body.message?.text,
      };
    },
    { name: opts.actionName ?? "slackPostMessage" },
  );
}
