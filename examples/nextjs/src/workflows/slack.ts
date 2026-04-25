import { atom, input } from "@workflow/core";
import { postMessage, slack } from "@workflow/integrations-slack";
import { z } from "zod";

export const slackInterventionTrigger = input(
  "slackInterventionTrigger",
  z.object({
    context: z
      .string()
      .default(
        "Review the Slack message details, then approve sending the message as the Slack bot.",
      ),
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
