import type { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "@hono/zod-openapi";
import { getCookie, setCookie } from "hono/cookie";
import {
  authenticateWorkOSAccessToken,
  authenticateWorkOSUserRequest,
} from "../auth/workos";
import { apiErrorResponse, PlatformApiError } from "../errors";
import type { BackendAppEnv } from "../types";

const ARCADE_USER_COOKIE = "hylo_arcade_user_token";
const ARCADE_USER_COOKIE_MAX_AGE_SECONDS = 10 * 60;
const ARCADE_API_BASE_URL = "https://api.arcade.dev";
const ARCADE_CLOUD_BASE_URL = "https://cloud.arcade.dev/api";
const WorkOSUserSchema = z.object({ email: z.string().email() }).passthrough();
const ArcadeAuthorizationStatusSchema = z
  .object({ status: z.string().optional() })
  .passthrough();

export function mountArcadeAuthApi(app: OpenAPIHono, env: BackendAppEnv) {
  app.post("/arcade/user-session", async (c) => {
    try {
      const auth = await authenticateWorkOSUserRequest(c, env, "");
      if (!auth) {
        throw new PlatformApiError(
          401,
          "unauthorized",
          "WorkOS user authentication is required.",
        );
      }
      const token = bearerToken(c.req.header("Authorization"));
      if (!token) {
        throw new PlatformApiError(
          401,
          "unauthorized",
          "Missing WorkOS access token.",
        );
      }
      setCookie(c, ARCADE_USER_COOKIE, token, {
        httpOnly: true,
        maxAge: ARCADE_USER_COOKIE_MAX_AGE_SECONDS,
        path: "/",
        sameSite: "Lax",
        secure: isSecureRequest(c.req.url),
      });
      return c.json({ ok: true, userId: auth.userId }, 200);
    } catch (e) {
      return apiErrorResponse(c, e);
    }
  });

  app.get("/arcade/user-verifier", async (c) => {
    try {
      const flowId = c.req.query("flow_id")?.trim();
      if (!flowId) {
        throw new PlatformApiError(
          400,
          "missing_flow_id",
          "Missing required query parameter: flow_id.",
        );
      }
      const token = getCookie(c, ARCADE_USER_COOKIE);
      if (!token) {
        throw new PlatformApiError(
          401,
          "missing_arcade_user_session",
          "Open Arcade authorization from the signed-in Hylo app before completing this verifier.",
        );
      }
      const auth = await authenticateWorkOSAccessToken(env, token, {
        requireOrganization: false,
      });
      const arcadeUserId = await workOSUserEmail(env, auth.userId);
      const result = await confirmArcadeUser(env, {
        flowId,
        userId: arcadeUserId,
      });
      if (result.authId) await waitForArcadeAuthorization(env, result.authId);
      return c.html(arcadeAuthorizedHtml(), 200);
    } catch (e) {
      return apiErrorResponse(c, e);
    }
  });
}

async function workOSUserEmail(
  env: BackendAppEnv,
  userId: string,
): Promise<string> {
  const apiKey = env.WORKOS_API_KEY?.trim();
  if (!apiKey) {
    throw new PlatformApiError(
      503,
      "workos_api_key_missing",
      "WORKOS_API_KEY is required to resolve the signed-in user's email for Arcade.",
    );
  }

  const response = await fetch(
    new URL(
      `/user_management/users/${encodeURIComponent(userId)}`,
      workOSApiOrigin(env.WORKOS_API_HOSTNAME),
    ),
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    },
  );
  if (!response.ok) {
    throw new PlatformApiError(
      502,
      "workos_request_failed",
      `WorkOS user request failed with HTTP ${response.status}.`,
    );
  }

  return WorkOSUserSchema.parse(await response.json()).email;
}

async function confirmArcadeUser(
  env: BackendAppEnv,
  args: { flowId: string; userId: string },
): Promise<{ authId?: string; nextUri?: string }> {
  const apiKey = env.ARCADE_API_KEY?.trim();
  if (!apiKey) {
    throw new PlatformApiError(
      503,
      "arcade_api_key_missing",
      "ARCADE_API_KEY is required to confirm Arcade users.",
    );
  }
  const response = await fetch(
    new URL("/api/v1/oauth/confirm_user", arcadeCloudBaseUrl(env)),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        flow_id: args.flowId,
        user_id: args.userId,
      }),
    },
  );
  if (!response.ok) {
    throw new PlatformApiError(
      400,
      "arcade_user_confirmation_failed",
      `Arcade user confirmation failed (${response.status}): ${await response.text()}`,
    );
  }
  const body = (await response.json()) as {
    auth_id?: unknown;
    next_uri?: unknown;
  };
  return {
    authId: typeof body.auth_id === "string" ? body.auth_id : undefined,
    nextUri: typeof body.next_uri === "string" ? body.next_uri : undefined,
  };
}

async function waitForArcadeAuthorization(
  env: BackendAppEnv,
  authId: string,
): Promise<void> {
  const apiKey = env.ARCADE_API_KEY?.trim();
  if (!apiKey) {
    throw new PlatformApiError(
      503,
      "arcade_api_key_missing",
      "ARCADE_API_KEY is required to check Arcade authorization status.",
    );
  }
  const url = new URL("/v1/auth/status", arcadeApiBaseUrl(env));
  url.searchParams.set("id", authId);
  url.searchParams.set("wait", "59");
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    throw new PlatformApiError(
      502,
      "arcade_authorization_status_failed",
      `Arcade authorization status failed (${response.status}): ${await response.text()}`,
    );
  }
  const body = ArcadeAuthorizationStatusSchema.parse(await response.json());
  if (body.status !== "completed") {
    throw new PlatformApiError(
      400,
      "arcade_authorization_not_completed",
      `Arcade authorization is ${body.status ?? "not completed"}.`,
    );
  }
}

function arcadeAuthorizedHtml(): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Arcade authorized</title>
  </head>
  <body>
    <p>Arcade authorization complete. You can close this window.</p>
    <script>
      window.opener?.postMessage({ type: "hylo:external-action-complete", provider: "arcade" }, "*");
      window.close();
    </script>
  </body>
</html>`;
}

function arcadeApiBaseUrl(env: BackendAppEnv): string {
  return (env.ARCADE_API_BASE_URL?.trim() || ARCADE_API_BASE_URL).replace(
    /\/+$/,
    "",
  );
}

function arcadeCloudBaseUrl(env: BackendAppEnv): string {
  return (env.ARCADE_CLOUD_BASE_URL?.trim() || ARCADE_CLOUD_BASE_URL).replace(
    /\/+$/,
    "",
  );
}

function bearerToken(header: string | undefined): string | undefined {
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

function isSecureRequest(url: string): boolean {
  return new URL(url).protocol === "https:";
}

function workOSApiOrigin(hostname: string | undefined): string {
  const value = hostname?.trim() || "api.workos.com";
  if (/^https?:\/\//i.test(value)) return value.replace(/\/+$/, "");
  return `https://${value.replace(/^\/+|\/+$/g, "")}`;
}
