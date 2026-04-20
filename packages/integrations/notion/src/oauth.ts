import { type Atom, atom, type Input } from "@workflow/core";
import { signOAuthState } from "@workflow/integrations-oauth";
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
};

export type NotionOAuthOptions = {
  login: Input<{ appBaseUrl: string }>;
  clientId: Input<string>;
  clientSecret: Input<string>;
  stateSecret: Input<string>;
  callbackPath?: string;
  name?: string;
};

const callbackPayloadSchema = z.object({
  code: z.string().optional(),
  state: z.string(),
  error: z.string().optional(),
});

const tokenResponseSchema = z
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

export function notionOAuth(opts: NotionOAuthOptions): Atom<NotionAuth> {
  const callbackPath =
    opts.callbackPath ?? "/api/workflow/integrations/notion/callback";

  return atom(
    async (get, requestIntervention, context) => {
      const login = get.maybe(opts.login);
      if (!login) return get.skip("No Notion login submitted");

      const clientId = get(opts.clientId);
      const clientSecret = get(opts.clientSecret);
      const stateSecret = get(opts.stateSecret);
      const redirectUri = new URL(callbackPath, login.appBaseUrl).toString();

      const interventionKey = "oauth-callback";
      const interventionId = context.interventionId(interventionKey);
      const state = await signOAuthState(
        { runId: context.runId, interventionId, redirectUri },
        stateSecret,
      );

      const authorizeUrl = buildAuthorizeUrl({ clientId, redirectUri, state });

      const callback = requestIntervention(
        interventionKey,
        callbackPayloadSchema,
        {
          title: "Connect Notion",
          description: `Make sure ${redirectUri} is configured as a redirect URI in your Notion integration's developer settings (https://www.notion.so/profile/integrations).`,
          action: {
            type: "open_url",
            url: authorizeUrl,
            label: "Connect Notion",
          },
        },
      );

      if (callback.error) {
        return get.skip(`Notion authorization failed: ${callback.error}`);
      }
      if (!callback.code) {
        throw new Error("Notion OAuth callback did not include a code.");
      }
      if (callback.state !== state) {
        throw new Error("Notion OAuth state mismatch.");
      }

      const token = await exchangeCode({
        clientId,
        clientSecret,
        code: callback.code,
        redirectUri,
      });

      return {
        accessToken: token.access_token,
        tokenType: token.token_type,
        botId: token.bot_id,
        workspaceId: token.workspace_id,
        workspaceName: token.workspace_name ?? undefined,
        workspaceIcon: token.workspace_icon ?? undefined,
        refreshToken: token.refresh_token,
      };
    },
    { name: opts.name ?? "notionOAuth" },
  );
}

function buildAuthorizeUrl(args: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL("https://api.notion.com/v1/oauth/authorize");
  url.searchParams.set("client_id", args.clientId);
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("owner", "user");
  url.searchParams.set("state", args.state);
  return url.toString();
}

async function exchangeCode(args: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<z.infer<typeof tokenResponseSchema>> {
  const response = await fetch("https://api.notion.com/v1/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${base64(`${args.clientId}:${args.clientSecret}`)}`,
      "Content-Type": "application/json",
      "Notion-Version": NOTION_VERSION,
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code: args.code,
      redirect_uri: args.redirectUri,
    }),
  });
  if (!response.ok) {
    throw new Error(
      `Notion token exchange failed (${response.status}): ${await preview(response)}`,
    );
  }
  return tokenResponseSchema.parse(await response.json());
}

async function preview(response: Response): Promise<string> {
  const text = await response.text();
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

function base64(value: string): string {
  return btoa(unescape(encodeURIComponent(value)));
}
