import {
  createConnection,
  type OAuthProviderSpec,
} from "@workflow/integrations-oauth";
import { z } from "zod";

export type SlackAuth = {
  accessToken: string;
  tokenType: string;
  scopes: string[];
  botUserId?: string;
  appId?: string;
  teamId?: string;
  teamName?: string;
  enterpriseId?: string;
  enterpriseName?: string;
  refreshToken?: string;
  expiresInSeconds?: number;
  brokerSessionId?: string;
};

export const slackAuthSchema: z.ZodType<SlackAuth> = z.object({
  accessToken: z.string(),
  tokenType: z.string(),
  scopes: z.array(z.string()),
  botUserId: z.string().optional(),
  appId: z.string().optional(),
  teamId: z.string().optional(),
  teamName: z.string().optional(),
  enterpriseId: z.string().optional(),
  enterpriseName: z.string().optional(),
  refreshToken: z.string().optional(),
  expiresInSeconds: z.number().optional(),
  brokerSessionId: z.string().optional(),
});

const rawTokenSchema = z
  .object({
    access_token: z.string(),
    token_type: z.string(),
    scope: z.string().optional(),
    bot_user_id: z.string().optional(),
    app_id: z.string().optional(),
    refresh_token: z.string().optional(),
    expires_in: z.number().optional(),
    team: z
      .object({
        id: z.string().optional(),
        name: z.string().optional(),
      })
      .nullable()
      .optional(),
    enterprise: z
      .object({
        id: z.string().optional(),
        name: z.string().optional(),
      })
      .nullable()
      .optional(),
  })
  .passthrough();

export const slackProvider: OAuthProviderSpec<SlackAuth> = {
  id: "slack",
  authorizeUrl: "https://slack.com/oauth/v2/authorize",
  tokenUrl: "https://slack.com/api/oauth.v2.access",
  defaultScopes: ["chat:write"],
  tokenSchema: slackAuthSchema,
  shapeToken: (raw) => {
    const parsed = rawTokenSchema.parse(raw);
    return {
      accessToken: parsed.access_token,
      tokenType: parsed.token_type,
      scopes:
        parsed.scope
          ?.split(",")
          .map((scope) => scope.trim())
          .filter(Boolean) ?? [],
      botUserId: parsed.bot_user_id,
      appId: parsed.app_id,
      teamId: parsed.team?.id,
      teamName: parsed.team?.name,
      enterpriseId: parsed.enterprise?.id,
      enterpriseName: parsed.enterprise?.name,
      refreshToken: parsed.refresh_token,
      expiresInSeconds: parsed.expires_in,
    };
  },
};

export const slack = createConnection({
  providerId: "slack",
  tokenSchema: slackAuthSchema,
  name: "slack",
});
