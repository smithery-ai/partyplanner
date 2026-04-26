import { atom, input } from "@workflow/core";
import {
  getChannelMessages,
  getThreadMessages,
  messageFromWebhook,
  postMessage,
  type SlackBlock,
  type SlackConversationMessage,
  slack,
  slackWebhookPayloadSchema,
} from "@workflow/integrations-slack";
import { z } from "zod";

const SLACK_CONTEXT_MESSAGE_LIMIT = 5;

export const slackInterventionTrigger = input(
  "slackInterventionTrigger",
  z.object({
    context: z.string(),
    channel: z
      .string()
      .min(1)
      .describe(
        "Slack channel ID or channel name where the bot should post the message.",
      ),
    message: z
      .string()
      .min(1)
      .describe("Message body for the Slack bot to send."),
  }),
  {
    title: "Send a Slack bot message",
    description:
      "Start a workflow that pauses for a human to approve the Slack channel and message, then posts it through the managed Slack integration.",
  },
);

const slackInterventionApproval = atom(
  (get, requestIntervention) => {
    const trigger = get.maybe(slackInterventionTrigger);
    if (!trigger) {
      return get.skip("No Slack intervention workflow was started");
    }

    const approval = requestIntervention(
      "approve-slack-message",
      z.object({
        approved: z
          .boolean()
          .describe("Whether the workflow should send this Slack bot message."),
        note: z
          .string()
          .optional()
          .describe("Optional note explaining the approval decision."),
      }),
      {
        title: "Approve the Slack bot message",
        description: `Context: ${trigger.context}\nChannel: ${trigger.channel}\nMessage: ${trigger.message}`,
      },
    );

    if (!approval.approved) {
      return get.skip(approval.note ?? "Slack message was not approved");
    }

    return trigger;
  },
  {
    name: "slackInterventionApproval",
    description:
      "Pause the workflow until a human approves the Slack channel and message.",
  },
);

const slackInterventionChannel = atom(
  (get) => get(slackInterventionApproval).channel,
  {
    name: "slackInterventionChannel",
  },
);

const slackInterventionMessageText = atom(
  (get) => get(slackInterventionApproval).message,
  {
    name: "slackInterventionMessageText",
  },
);

export const slackInterventionMessage = postMessage({
  auth: slack,
  channel: slackInterventionChannel,
  text: slackInterventionMessageText,
  actionName: "slackInterventionMessage",
});

export const slackInterventionResult = atom(
  (get) => {
    const delivery = get(slackInterventionMessage);
    return {
      workflow: "slack",
      action: "post-message",
      channel: delivery.channel,
      channelId: delivery.channelId,
      ts: delivery.ts,
      text: delivery.text,
    };
  },
  {
    name: "slackInterventionResult",
    description:
      "Post the requested Slack bot message and expose the delivery result.",
  },
);

export const slackWebhookEvent = input(
  "slackWebhookEvent",
  slackWebhookPayloadSchema,
  {
    title: "Slack webhook event",
    description:
      "Handle a managed Slack webhook event forwarded by the Hylo backend.",
  },
);

export const slackReceivedMessage = messageFromWebhook({
  webhook: slackWebhookEvent,
  name: "slackReceivedMessage",
});

const slackActionableMessage = atom(
  (get) => {
    const message = get(slackReceivedMessage);
    if (message.botId || message.subtype === "bot_message") {
      return get.skip("Slack bot-authored messages are ignored");
    }
    if (message.kind !== "app_mention" && message.kind !== "message") {
      return get.skip(`Slack event type ${message.kind} is ignored`);
    }
    return message;
  },
  {
    name: "slackActionableMessage",
  },
);

const slackContextChannel = atom((get) => get(slackActionableMessage).channel, {
  name: "slackContextChannel",
});

const slackContextThreadTs = atom(
  (get) => get(slackActionableMessage).threadTs,
  {
    name: "slackContextThreadTs",
  },
);

const slackContextLatestTs = atom((get) => get(slackActionableMessage).ts, {
  name: "slackContextLatestTs",
});

export const slackThreadContextMessages = getThreadMessages({
  auth: slack,
  channel: slackContextChannel,
  threadTs: slackContextThreadTs,
  latest: slackContextLatestTs,
  inclusive: true,
  limit: SLACK_CONTEXT_MESSAGE_LIMIT,
  name: "slackThreadContextMessages",
});

export const slackChannelContextMessages = getChannelMessages({
  auth: slack,
  channel: slackContextChannel,
  latest: slackContextLatestTs,
  inclusive: true,
  limit: SLACK_CONTEXT_MESSAGE_LIMIT,
  name: "slackChannelContextMessages",
});

const slackContextReplyBlocks = atom(
  (get): SlackBlock[] => {
    const threadMessages = get(slackThreadContextMessages).messages;
    const channelMessages = get(slackChannelContextMessages).messages;

    return [
      richTextBox(
        `Last ${SLACK_CONTEXT_MESSAGE_LIMIT} messages in thread`,
        formatMessages(threadMessages),
      ),
      richTextBox(
        `Last ${SLACK_CONTEXT_MESSAGE_LIMIT} messages in channel`,
        formatMessages(channelMessages),
      ),
    ];
  },
  {
    name: "slackContextReplyBlocks",
  },
);

const slackContextReplyText = atom(
  () =>
    `Last ${SLACK_CONTEXT_MESSAGE_LIMIT} messages in this thread and channel.`,
  {
    name: "slackContextReplyText",
  },
);

export const slackContextReply = postMessage({
  auth: slack,
  channel: slackContextChannel,
  threadTs: slackContextThreadTs,
  text: slackContextReplyText,
  blocks: slackContextReplyBlocks,
  actionName: "slackContextReply",
});

export const slackContextReplyResult = atom(
  (get) => {
    const received = get(slackActionableMessage);
    const delivery = get(slackContextReply);
    return {
      workflow: "slack",
      action: "reply-with-context",
      event: received.kind,
      channel: delivery.channel,
      threadTs: delivery.threadTs,
      ts: delivery.ts,
    };
  },
  {
    name: "slackContextReplyResult",
    description:
      "Reply in-thread with recent Slack thread and channel context.",
  },
);

function richTextBox(title: string, body: string): SlackBlock {
  return {
    type: "rich_text",
    elements: [
      {
        type: "rich_text_section",
        elements: [{ type: "text", text: title, style: { bold: true } }],
      },
      {
        type: "rich_text_preformatted",
        border: 0,
        elements: [{ type: "text", text: body || "No messages found." }],
      },
    ],
  };
}

function formatMessages(messages: SlackConversationMessage[]): string {
  return [...messages]
    .sort((a, b) => Number(a.ts) - Number(b.ts))
    .map((message) => {
      const author = message.user
        ? `<@${message.user}>`
        : (message.botId ?? "unknown");
      return `${slackTime(message.ts)} ${author}: ${normalizeSlackText(
        message.text,
      )}`;
    })
    .join("\n");
}

function slackTime(ts: string): string {
  const seconds = Number(ts.split(".")[0]);
  if (!Number.isFinite(seconds)) return ts;
  return new Date(seconds * 1000).toISOString().slice(11, 19);
}

function normalizeSlackText(text: string | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim() || "(no text)";
}
