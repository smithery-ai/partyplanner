import { Hono } from "hono";
import { z } from "zod";
import { htmlResponse, normalizeBasePath, responsePreview } from "./internal";

type HonoAppLike = {
  fetch(request: Request): Response | Promise<Response>;
};

export type OAuthHandoffRoutesOptions = {
  // The parent workflow Hono app. Handoff route POSTs the resolved token
  // back into the workflow intervention endpoint via the app's .fetch().
  workflowApp: HonoAppLike;
  // Base path of the workflow routes on the parent app.
  workflowBasePath?: string;
  // Base URL of the broker server (e.g. `${HYLO_BACKEND_URL}/oauth`).
  // Per-provider exchange URL is `${brokerBaseUrl}/${providerId}/exchange`.
  brokerBaseUrl: string;
  // Static API key the runtime presents to the broker. In non-production
  // environments this falls back to the package dev default when omitted.
  getAppToken?: () => string | undefined;
  // Provider IDs to mount handoff routes for. One GET `/${id}/handoff` per id.
  providers: string[];
  // Title used by per-provider success/error pages. Looked up by provider id.
  successTitles?: Record<string, string>;
  errorTitles?: Record<string, string>;
};

const brokerExchangeResponse = z.object({
  runId: z.string(),
  interventionId: z.string(),
  token: z.unknown(),
});

// Returns a Hono sub-app with one GET `/:providerId/handoff` route per
// provider in `opts.providers`. Mount it on the parent app with:
//   app.route("/api/workflow/integrations", createOAuthHandoffRoutes({...}))
//
// Flow:
//   - Broker redirects user's browser to this route with `?handoff=<code>`.
//   - Route exchanges the code with `${broker}/${id}/exchange` to get the
//     resolved token + the original runId/interventionId.
//   - Route POSTs the token into the workflow intervention endpoint, which
//     resumes the run.
export function createOAuthHandoffRoutes(
  opts: OAuthHandoffRoutesOptions,
): Hono {
  const app = new Hono();
  const brokerBaseUrl = trimTrailingSlash(opts.brokerBaseUrl);

  for (const providerId of opts.providers) {
    const successTitle =
      opts.successTitles?.[providerId] ?? `${capitalize(providerId)} connected`;
    const errorTitle =
      opts.errorTitles?.[providerId] ??
      `${capitalize(providerId)} OAuth failed`;
    const exchangeUrl = `${brokerBaseUrl}/${providerId}/exchange`;

    app.get(`/${providerId}/handoff`, async (c) => {
      const url = new URL(c.req.url);
      const handoff = url.searchParams.get("handoff");
      const errorParam = url.searchParams.get("error");
      const runIdParam = url.searchParams.get("runId");
      const interventionIdParam = url.searchParams.get("interventionId");

      // Error path: broker redirected here with `?error=...&runId=&interventionId=`.
      // POST `{ error }` to the intervention so the atom can `get.skip(...)`.
      if (errorParam && runIdParam && interventionIdParam) {
        const interventionUrl = buildInterventionUrl(
          url,
          opts.workflowBasePath,
          runIdParam,
          interventionIdParam,
        );
        const response = await opts.workflowApp.fetch(
          new Request(interventionUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              payload: { error: errorParam },
              autoAdvance: true,
            }),
          }),
        );
        if (!response.ok) {
          return htmlResponse(
            errorTitle,
            await response.text(),
            response.status,
          );
        }
        return htmlResponse(errorTitle, errorParam, 400);
      }

      if (!handoff) {
        return htmlResponse(errorTitle, "Missing handoff code.", 400);
      }

      const appToken = resolveAppToken(opts.getAppToken?.());
      if (!appToken) {
        return htmlResponse(
          errorTitle,
          "HYLO_API_KEY is required to talk to the OAuth broker.",
          500,
        );
      }

      const exchangeResp = await fetch(exchangeUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${appToken}`,
        },
        body: JSON.stringify({ handoff }),
      });
      if (!exchangeResp.ok) {
        return htmlResponse(
          errorTitle,
          await responsePreview(exchangeResp),
          exchangeResp.status,
        );
      }

      let parsed: z.infer<typeof brokerExchangeResponse>;
      try {
        parsed = brokerExchangeResponse.parse(await exchangeResp.json());
      } catch (e) {
        return htmlResponse(
          errorTitle,
          `Broker exchange returned an unexpected payload: ${
            e instanceof Error ? e.message : String(e)
          }`,
          502,
        );
      }

      const interventionUrl = buildInterventionUrl(
        url,
        opts.workflowBasePath,
        parsed.runId,
        parsed.interventionId,
      );
      const response = await opts.workflowApp.fetch(
        new Request(interventionUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ payload: parsed.token, autoAdvance: true }),
        }),
      );

      if (!response.ok) {
        return htmlResponse(errorTitle, await response.text(), response.status);
      }

      return htmlResponse(
        successTitle,
        "The workflow run has been resumed. You can return to the workflow tab.",
      );
    });
  }

  return app;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

const DEV_API_KEY = "local-dev-hylo-api-key";

function resolveAppToken(explicit: string | undefined): string | undefined {
  if (explicit?.trim()) return explicit;
  const envValue = envVar("HYLO_API_KEY");
  if (envValue) return envValue;
  if (envVar("NODE_ENV") === "production") return undefined;
  return DEV_API_KEY;
}

function envVar(name: string): string | undefined {
  const env = (
    globalThis as {
      process?: { env?: Record<string, string | undefined> };
    }
  ).process?.env;
  return env?.[name];
}

function buildInterventionUrl(
  reqUrl: URL,
  workflowBasePath: string | undefined,
  runId: string,
  interventionId: string,
): URL {
  const basePath = normalizeBasePath(workflowBasePath ?? "/api/workflow");
  return new URL(
    `${basePath}/runs/${encodeURIComponent(
      runId,
    )}/interventions/${encodeURIComponent(interventionId)}`,
    reqUrl.origin,
  );
}

function capitalize(value: string): string {
  if (value.length === 0) return value;
  return `${value[0].toUpperCase()}${value.slice(1)}`;
}
