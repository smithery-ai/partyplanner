import { atom, input } from "@workflow/core";
import { postMessage, slack } from "@workflow/integrations-slack";
import { z } from "zod";

export const slackInterventionTrigger = input(
  "slackInterventionTrigger",
  z.object({
    context: z.string(),
  }),
  {
    title: "Send a Slack bot message",
    description:
      "Start a workflow that pauses for a human to enter the Slack channel and message, then posts it through the managed Slack integration.",
  },
);

const slackInterventionDraft = atom(
  (get, requestIntervention) => {
    const trigger = get.maybe(slackInterventionTrigger);
    if (!trigger) {
      return get.skip("No Slack intervention workflow was started");
    }

    return requestIntervention(
      "compose-slack-message",
      z.object({
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
        title: "Compose the Slack bot message",
        description: trigger.context,
      },
    );
  },
  {
    name: "slackInterventionDraft",
    description:
      "Pause the workflow until a human provides the Slack channel and message.",
  },
);

const slackInterventionChannel = atom(
  (get) => get(slackInterventionDraft).channel,
  {
    name: "slackInterventionChannel",
  },
);

const slackInterventionMessageText = atom(
  (get) => get(slackInterventionDraft).message,
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
