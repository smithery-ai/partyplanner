import { createConnection, type OAuthProviderSpec } from "@workflow/integrations-oauth";
import { z } from "zod";

export type SlackAuth = {
  accessToken: string;
  tokenType: string;
  scope: string;
  botUserId: string;
  teamId: string;
  teamName: string;
  refreshToken?: string;
  brokerSessionId?: string;
};

export const slackAuthSchema = z.object({
  accessToken: z.string(),
  tokenType: z.string(),
  scope: z.string(),
  botUserId: z.string(),
  teamId: z.string(),
  teamName: z.string(),
  refreshToken: z.string().optional(),
  brokerSessionId: z.string().optional(),
});

export const slackProvider: OAuthProviderSpec<SlackAuth> = {
  id: "slack",
  authorizeUrl: "https://slack.com/oauth/v2/authorize",
  tokenUrl: "https://slack.com/api/oauth.v2.access",
  defaultScopes: ["chat:write", "channels:read"],
  tokenSchema: slackAuthSchema,
  shapeToken(raw: unknown): SlackAuth {
    const r = raw as Record<string, unknown>;
    const team = r.team as Record<string, unknown> | undefined;
    return {
      accessToken: String(r.access_token ?? ""),
      tokenType: String(r.token_type ?? "bot"),
      scope: String(r.scope ?? ""),
      botUserId: String(r.bot_user_id ?? ""),
      teamId: String(team?.id ?? ""),
      teamName: String(team?.name ?? ""),
      refreshToken:
        typeof r.refresh_token === "string" ? r.refresh_token : undefined,
    };
  },
};

// Pre-built brokered connection atom for Slack. Usage:
//   const auth = slack;
//   const token = await get(auth);
export const slack = createConnection({
  providerId: "slack",
  tokenSchema: slackAuthSchema,
  name: "slack",
});
