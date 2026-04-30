import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createOAuthBrokerServer } from "../src/server";
import { createInMemoryBrokerStore } from "../src/store";

describe("OAuth broker server", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accepts callback state after a realistic user consent delay", async () => {
    let now = 1_000;
    const app = createOAuthBrokerServer({
      brokerBaseUrl: "https://broker.example/oauth",
      store: createInMemoryBrokerStore({ now: () => now }),
      authenticateAppToken: (token) =>
        token === "app-token" ? { appId: "test-app" } : undefined,
      providers: [
        {
          clientId: "client-id",
          clientSecret: "client-secret",
          spec: {
            id: "notion",
            authorizeUrl: "https://provider.example/authorize",
            tokenUrl: "https://provider.example/token",
            defaultScopes: [],
            tokenSchema: z.object({ accessToken: z.string() }),
            shapeToken: (raw) => ({
              accessToken: (raw as { access_token: string }).access_token,
            }),
          },
        },
      ],
    });

    const start = await app.request("/notion/start", {
      method: "POST",
      headers: {
        Authorization: "Bearer app-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        runtimeHandoffUrl: "https://runtime.example/handoff",
        runId: "run-1",
        interventionId: "notion:oauth-callback",
      }),
    });
    expect(start.status).toBe(200);
    const { authorizeUrl } = (await start.json()) as { authorizeUrl: string };
    const state = new URL(authorizeUrl).searchParams.get("state");
    expect(state).toBeTruthy();

    now += 10 * 60_000;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          access_token: "notion-token",
        }),
      ),
    );

    const callback = await app.request(
      `/notion/callback?code=code-1&state=${encodeURIComponent(state ?? "")}`,
    );

    expect(callback.status).toBe(302);
    const location = callback.headers.get("location");
    expect(location).toMatch(/^https:\/\/runtime\.example\/handoff\?handoff=/);
  });

  it("redirects token exchange failures back to the runtime intervention", async () => {
    const app = createOAuthBrokerServer({
      brokerBaseUrl: "https://broker.example/oauth",
      store: createInMemoryBrokerStore(),
      authenticateAppToken: (token) =>
        token === "app-token" ? { appId: "test-app" } : undefined,
      providers: [
        {
          clientId: "client-id",
          clientSecret: "client-secret",
          spec: {
            id: "notion",
            authorizeUrl: "https://provider.example/authorize",
            tokenUrl: "https://provider.example/token",
            defaultScopes: [],
            tokenSchema: z.object({ accessToken: z.string() }),
            shapeToken: (raw) => ({
              accessToken: (raw as { access_token: string }).access_token,
            }),
          },
        },
      ],
    });

    const start = await app.request("/notion/start", {
      method: "POST",
      headers: {
        Authorization: "Bearer app-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        runtimeHandoffUrl: "https://runtime.example/handoff",
        runId: "run-1",
        interventionId: "notion:oauth-callback",
      }),
    });
    const { authorizeUrl } = (await start.json()) as { authorizeUrl: string };
    const state = new URL(authorizeUrl).searchParams.get("state");
    expect(state).toBeTruthy();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: "invalid_client", request_id: "request-1" },
          { status: 401 },
        ),
      ),
    );

    const callback = await app.request(
      `/notion/callback?code=code-1&state=${encodeURIComponent(state ?? "")}`,
    );

    expect(callback.status).toBe(302);
    const location = new URL(callback.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe(
      "https://runtime.example/handoff",
    );
    expect(location.searchParams.get("runId")).toBe("run-1");
    expect(location.searchParams.get("interventionId")).toBe(
      "notion:oauth-callback",
    );
    expect(location.searchParams.get("error")).toContain("invalid_client");
  });
});
