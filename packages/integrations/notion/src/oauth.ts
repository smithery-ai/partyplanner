import {
  type AuthorizeParamsContext,
  createConnection,
  defaultAuthorizeParams,
  defaultTokenRequest,
  type OAuthProviderSpec,
  type TokenRequestContext,
} from "@workflow/integrations-oauth";
import { z } from "zod";

export const NOTION_VERSION = "2022-06-28";

export type NotionAuth = {
  accessToken: string;
  tokenType: string;
  botId: string;
  workspaceId?: string;
  workspaceName?: string;
  workspaceIcon?: string;
  refreshToken?: string;
  brokerSessionId?: string;
};

export const notionAuthSchema: z.ZodType<NotionAuth> = z.object({
  accessToken: z.string(),
  tokenType: z.string(),
  botId: z.string(),
  workspaceId: z.string().optional(),
  workspaceName: z.string().optional(),
  workspaceIcon: z.string().optional(),
  refreshToken: z.string().optional(),
  brokerSessionId: z.string().optional(),
});

const rawTokenSchema = z
  .object({
    access_token: z.string(),
    token_type: z.string(),
    bot_id: z.string(),
    workspace_id: z.string().optional(),
    workspace_name: z.string().nullable().optional(),
    workspace_icon: z.string().nullable().optional(),
    refresh_token: z.string().optional(),
  })
  .passthrough();

// Notion authorize URL needs `owner=user`. Otherwise standard OAuth 2.0.
function buildAuthorizeParams(ctx: AuthorizeParamsContext): URLSearchParams {
  const params = defaultAuthorizeParams(ctx);
  params.set("owner", "user");
  return params;
}

// Notion token endpoint expects a JSON body, not form-encoded.
function buildTokenRequest(ctx: TokenRequestContext): Request {
  const fallback = defaultTokenRequest(
    "https://api.notion.com/v1/oauth/token",
    ctx,
  );
  return new Request(fallback.url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${base64(`${ctx.clientId}:${ctx.clientSecret}`)}`,
      "Content-Type": "application/json",
      "Notion-Version": NOTION_VERSION,
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code: ctx.code,
      redirect_uri: ctx.redirectUri,
    }),
  });
}

function base64(value: string): string {
  return btoa(unescape(encodeURIComponent(value)));
}

// Provider spec consumed by the OAuth broker on the backend. Worker code
// does not import this; the backend uses it to register the curated Notion
// connector.
export const notionProvider: OAuthProviderSpec<NotionAuth> = {
  id: "notion",
  authorizeUrl: "https://api.notion.com/v1/oauth/authorize",
  tokenUrl: "https://api.notion.com/v1/oauth/token",
  defaultScopes: [],
  tokenSchema: notionAuthSchema,
  buildAuthorizeParams,
  buildTokenRequest,
  shapeToken: (raw) => {
    const parsed = rawTokenSchema.parse(raw);
    return {
      accessToken: parsed.access_token,
      tokenType: parsed.token_type,
      botId: parsed.bot_id,
      workspaceId: parsed.workspace_id,
      workspaceName: parsed.workspace_name ?? undefined,
      workspaceIcon: parsed.workspace_icon ?? undefined,
      refreshToken: parsed.refresh_token,
    };
  },
};

// Pre-built brokered connection. Import this in worker code:
//   import { notion } from "@workflow/integrations-notion";
export const notion = createConnection({
  providerId: "notion",
  tokenSchema: notionAuthSchema,
  name: "notion",
});
