import { describe, expect, it, vi } from "vitest";
import {
  type DeploymentSource,
  deploymentSourceFromList,
  dispatchTickToDeployments,
} from "../src/scheduling/dispatcher";

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json" },
  });
}

function fixedSource(
  targets: Parameters<DeploymentSource["list"]>[0] extends never
    ? Awaited<ReturnType<DeploymentSource["list"]>>
    : Awaited<ReturnType<DeploymentSource["list"]>>,
): DeploymentSource {
  return { list: async () => targets };
}

describe("dispatchTickToDeployments", () => {
  it("POSTs /schedules/tick to every target with the tick timestamp", async () => {
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        return jsonResponse({ at: JSON.parse(String(init?.body ?? "{}")).at });
      },
    );

    const at = new Date("2026-04-27T15:00:00Z");
    const result = await dispatchTickToDeployments(
      {
        source: fixedSource([
          { deploymentId: "d1", workflowApiUrl: "https://w1.example/" },
          { deploymentId: "d2", workflowApiUrl: "https://w2.example" },
        ]),
        fetch: fetchMock as unknown as typeof fetch,
      },
      at,
    );

    expect(result).toEqual({
      at: at.toISOString(),
      attempted: 2,
      ok: 2,
      failed: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const urls = fetchMock.mock.calls.map((c) => String(c[0])).sort();
    expect(urls).toEqual([
      "https://w1.example/schedules/tick",
      "https://w2.example/schedules/tick",
    ]);

    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit;
      expect(init.method).toBe("POST");
      const body = JSON.parse(String(init.body));
      expect(body).toEqual({ at: at.toISOString() });
    }
  });

  it("forwards an Authorization bearer when the target carries an apiKey", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    await dispatchTickToDeployments(
      {
        source: fixedSource([
          {
            deploymentId: "d1",
            workflowApiUrl: "https://w1.example",
            apiKey: "secret-key",
          },
        ]),
        fetch: fetchMock as unknown as typeof fetch,
      },
      new Date(),
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer secret-key");
  });

  it("counts non-2xx responses as failures and surfaces them via onError", async () => {
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL) =>
        new Response("nope", { status: 500, statusText: "Internal" }),
    );
    const errors: Array<{ message: string; deploymentId: string }> = [];

    const result = await dispatchTickToDeployments(
      {
        source: fixedSource([
          { deploymentId: "broken", workflowApiUrl: "https://w.example" },
        ]),
        fetch: fetchMock as unknown as typeof fetch,
        onError: (error, target) => {
          errors.push({
            message: error instanceof Error ? error.message : String(error),
            deploymentId: target.deploymentId,
          });
        },
      },
      new Date(),
    );

    expect(result).toEqual(expect.objectContaining({ ok: 0, failed: 1 }));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.deploymentId).toBe("broken");
    expect(errors[0]?.message).toMatch(/500/);
  });

  it("counts thrown fetch errors as failures (e.g. network down)", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });

    const result = await dispatchTickToDeployments(
      {
        source: fixedSource([
          { deploymentId: "x", workflowApiUrl: "https://w.example" },
        ]),
        fetch: fetchMock as unknown as typeof fetch,
      },
      new Date(),
    );
    expect(result).toEqual(expect.objectContaining({ ok: 0, failed: 1 }));
  });

  it("drops trailing slash duplication when joining URLs", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    await dispatchTickToDeployments(
      {
        source: fixedSource([
          { deploymentId: "a", workflowApiUrl: "https://w.example/" },
          { deploymentId: "b", workflowApiUrl: "https://w.example" },
        ]),
        fetch: fetchMock as unknown as typeof fetch,
      },
      new Date(),
    );
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls).toContain("https://w.example/schedules/tick");
    expect(urls.filter((u) => u.includes("//schedules"))).toEqual([]);
  });
});

describe("deploymentSourceFromList", () => {
  const baseRecord = {
    tenantId: "t1",
    dispatchNamespace: "hylo-tenants",
    tags: [],
    createdAt: 0,
    updatedAt: 0,
  };

  it("filters out records missing workflowApiUrl", async () => {
    const source = deploymentSourceFromList(async () => [
      {
        ...baseRecord,
        deploymentId: "ok",
        workflowApiUrl: "https://a.example",
      },
      { ...baseRecord, deploymentId: "no-url" },
      {
        ...baseRecord,
        deploymentId: "empty-url",
        workflowApiUrl: "",
      },
    ]);

    const targets = await source.list();
    expect(targets.map((t) => t.deploymentId)).toEqual(["ok"]);
  });

  it("attaches the configured apiKey to every target", async () => {
    const source = deploymentSourceFromList(
      async () => [
        {
          ...baseRecord,
          deploymentId: "d",
          workflowApiUrl: "https://a.example",
        },
      ],
      { apiKey: "k" },
    );
    const targets = await source.list();
    expect(targets[0]?.apiKey).toBe("k");
  });

  it("omits apiKey when none is configured", async () => {
    const source = deploymentSourceFromList(async () => [
      {
        ...baseRecord,
        deploymentId: "d",
        workflowApiUrl: "https://a.example",
      },
    ]);
    const targets = await source.list();
    expect(targets[0]).not.toHaveProperty("apiKey");
  });
});
