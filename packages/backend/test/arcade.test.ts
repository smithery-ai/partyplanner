import type { WorkflowPostgresDb } from "@workflow/postgres";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBackendApp } from "../src/app";

const API_KEY = "test-api-key";

describe("Arcade", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("proxies Arcade requests with the backend Arcade API key", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe("https://api.arcade.dev/v1/tools/execute");
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe("Bearer arcade-backend-key");
        expect(headers.get("content-type")).toBe("application/json");
        expect(init?.body).toBeInstanceOf(ArrayBuffer);
        return Response.json({ ok: true });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const app = createBackendApp({
      db: fakeDb(),
      env: {
        ARCADE_API_KEY: "arcade-backend-key",
        HYLO_API_KEY: API_KEY,
      },
    });

    const response = await app.request(
      "http://backend.test/arcade/v1/tools/execute",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ tool_name: "Linear.ListProjects" }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects proxy requests without the Hylo app token", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const app = createBackendApp({
      db: fakeDb(),
      env: {
        ARCADE_API_KEY: "arcade-backend-key",
        HYLO_API_KEY: API_KEY,
      },
    });

    const response = await app.request(
      "http://backend.test/arcade/v1/tools/execute",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("confirms the Arcade flow with the signed-in WorkOS user email", async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    const publicJwk = await exportJWK(publicKey);
    const kid = "arcade-test-key";
    const issuer = "https://issuer.test";
    const jwksUrl = "https://workos.test/jwks/arcade";
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid })
      .setIssuer(issuer)
      .setSubject("user_123")
      .setExpirationTime("10m")
      .sign(privateKey);

    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === jwksUrl) {
          return Response.json({ keys: [{ ...publicJwk, kid, alg: "ES256" }] });
        }
        if (url === "https://workos.test/user_management/users/user_123") {
          const headers = new Headers(init?.headers);
          expect(headers.get("Authorization")).toBe("Bearer workos-api-key");
          return Response.json({
            id: "user_123",
            email: "ani@smithery.ai",
          });
        }
        if (url === "https://arcade.test/api/v1/oauth/confirm_user") {
          const headers = new Headers(init?.headers);
          expect(headers.get("Authorization")).toBe("Bearer arcade-api-key");
          expect(JSON.parse(String(init?.body))).toEqual({
            flow_id: "flow_123",
            user_id: "ani@smithery.ai",
          });
          return Response.json({
            auth_id: "auth_123",
            next_uri: "https://client.test/arcade/success",
          });
        }
        if (
          url === "https://api.arcade.dev/v1/auth/status?id=auth_123&wait=59"
        ) {
          const headers = new Headers(init?.headers);
          expect(headers.get("Authorization")).toBe("Bearer arcade-api-key");
          return Response.json({ status: "completed" });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const app = createBackendApp({
      db: fakeDb(),
      env: {
        ARCADE_API_KEY: "arcade-api-key",
        ARCADE_CLOUD_BASE_URL: "https://arcade.test",
        HYLO_API_KEY: "hylo-api-key",
        WORKOS_API_KEY: "workos-api-key",
        WORKOS_API_HOSTNAME: "https://workos.test",
        WORKOS_CLIENT_ID: "client_test",
        WORKOS_ISSUER: issuer,
        WORKOS_JWKS_URL: jwksUrl,
      },
    });

    const session = await app.request(
      "https://backend.test/arcade/user-session",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    expect(session.status).toBe(200);
    const cookie = session.headers.get("Set-Cookie");
    expect(cookie).toContain("hylo_arcade_user_token=");
    expect(cookie).toContain("HttpOnly");

    const verifier = await app.request(
      "https://backend.test/arcade/user-verifier?flow_id=flow_123",
      {
        headers: { Cookie: cookie ?? "" },
      },
    );

    expect(verifier.status).toBe(200);
    const html = await verifier.text();
    expect(html).toContain("Arcade authorization complete");
    expect(html).toContain("hylo:external-action-complete");
  });
});

function fakeDb(): WorkflowPostgresDb {
  return {} as WorkflowPostgresDb;
}
