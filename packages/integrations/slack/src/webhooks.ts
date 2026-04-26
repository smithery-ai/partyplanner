import { z } from "zod";

export const slackEventSchema = z
  .object({
    type: z.string(),
    subtype: z.string().optional(),
    user: z.string().optional(),
    bot_id: z.string().optional(),
    ts: z.string().optional(),
    event_ts: z.string().optional(),
    text: z.string().optional(),
    channel: z.string().optional(),
    thread_ts: z.string().optional(),
    parent_user_id: z.string().optional(),
  })
  .passthrough();

export const slackEventCallbackPayloadSchema = z
  .object({
    type: z.literal("event_callback"),
    team_id: z.string().optional(),
    api_app_id: z.string().optional(),
    event_id: z.string().optional(),
    event_time: z.number().optional(),
    event: slackEventSchema,
  })
  .passthrough();

export const slackProviderWebhookPayloadSchema = z
  .object({
    source: z.literal("slack"),
    kind: z.string(),
    teamId: z.string().optional(),
    appId: z.string().optional(),
    eventId: z.string().optional(),
    eventTime: z.number().optional(),
    payload: z.unknown(),
  })
  .passthrough();

export const slackWebhookEnvelopeSchema = z
  .object({
    receivedAt: z.number().optional(),
    method: z.string().optional(),
    route: z.string().optional(),
    url: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    query: z.record(z.string(), z.string()).optional(),
    payload: slackProviderWebhookPayloadSchema,
  })
  .passthrough();

export const slackWebhookPayloadSchema = z.union([
  slackProviderWebhookPayloadSchema,
  slackWebhookEnvelopeSchema,
]);

export type SlackEvent = z.infer<typeof slackEventSchema>;
export type SlackEventCallbackPayload = z.infer<
  typeof slackEventCallbackPayloadSchema
>;
export type SlackWebhookPayload = z.infer<
  typeof slackProviderWebhookPayloadSchema
>;
export type SlackWebhookEnvelope = z.infer<typeof slackWebhookEnvelopeSchema>;
