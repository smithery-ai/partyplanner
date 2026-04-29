import { OpenAPIHono } from "@hono/zod-openapi";
import type { BackendAppEnv } from "../types";

const DEFAULT_ARCADE_BASE_URL = "https://api.arcade.dev";

export function createArcadeProxyRoutes(env: BackendAppEnv, apiKey: string) {
  const app = new OpenAPIHono();

  app.all("/v1/*", async (c) => {
    const authorized = bearerToken(c.req.raw) === apiKey;
    if (!authorized) {
      return c.json({ error: "unauthorized" }, 401);
    }

    const arcadeApiKey = env.ARCADE_API_KEY?.trim();
    if (!arcadeApiKey) {
      return c.json({ error: "ARCADE_API_KEY is not configured" }, 503);
    }

    const incoming = new URL(c.req.url);
    const target = new URL(
      `${incoming.pathname.replace(/^\/arcade/, "")}${incoming.search}`,
      arcadeBaseUrl(env),
    );
    const headers = new Headers();
    const contentType = c.req.raw.headers.get("content-type");
    if (contentType) headers.set("content-type", contentType);
    headers.set("authorization", `Bearer ${arcadeApiKey}`);

    const response = await fetch(target, {
      method: c.req.method,
      headers,
      body: hasBody(c.req.method) ? await c.req.arrayBuffer() : undefined,
    });

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders(response.headers),
    });
  });

  return app;
}

function arcadeBaseUrl(env: BackendAppEnv): string {
  return (env.ARCADE_BASE_URL?.trim() || DEFAULT_ARCADE_BASE_URL).replace(
    /\/+$/,
    "",
  );
}

function bearerToken(request: Request): string | undefined {
  const authorization = request.headers.get("authorization")?.trim();
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

function hasBody(method: string): boolean {
  return !["GET", "HEAD"].includes(method.toUpperCase());
}

function responseHeaders(headers: Headers): Headers {
  const result = new Headers();
  for (const name of ["content-type", "cache-control"]) {
    const value = headers.get(name);
    if (value) result.set(name, value);
  }
  return result;
}
