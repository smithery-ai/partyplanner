import { type Atom, action } from "@workflow/core";
import type { SlackAuth } from "./oauth";

export function sendMessage(opts: {
  auth: Atom<SlackAuth>;
  channel: Atom<string> | string;
  text: Atom<string> | string;
}) {
  return action(async (get) => {
    const token = await get(opts.auth);
    const channel =
      typeof opts.channel === "string" ? opts.channel : await get(opts.channel);
    const text =
      typeof opts.text === "string" ? opts.text : await get(opts.text);

    const resp = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel, text }),
    });
    if (!resp.ok) {
      throw new Error(`Slack API error: ${resp.status} ${await resp.text()}`);
    }
    const result = (await resp.json()) as { ok: boolean; error?: string };
    if (!result.ok) {
      throw new Error(`Slack API error: ${result.error}`);
    }
    return result;
  });
}

export function addReaction(opts: {
  auth: Atom<SlackAuth>;
  channel: Atom<string> | string;
  timestamp: Atom<string> | string;
  name: Atom<string> | string;
}) {
  return action(async (get) => {
    const token = await get(opts.auth);
    const channel =
      typeof opts.channel === "string" ? opts.channel : await get(opts.channel);
    const timestamp =
      typeof opts.timestamp === "string"
        ? opts.timestamp
        : await get(opts.timestamp);
    const name =
      typeof opts.name === "string" ? opts.name : await get(opts.name);

    const resp = await fetch("https://slack.com/api/reactions.add", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel, timestamp, name }),
    });
    if (!resp.ok) {
      throw new Error(`Slack API error: ${resp.status} ${await resp.text()}`);
    }
    const result = (await resp.json()) as { ok: boolean; error?: string };
    if (!result.ok) {
      throw new Error(`Slack API error: ${result.error}`);
    }
    return result;
  });
}
