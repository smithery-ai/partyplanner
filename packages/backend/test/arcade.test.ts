import type { WorkflowPostgresDb } from "@workflow/postgres";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBackendApp } from "../src/app";

const API_KEY = "test-api-key";

describe("Arcade proxy", () => {
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
});

function fakeDb(): WorkflowPostgresDb {
  return {} as WorkflowPostgresDb;
}
