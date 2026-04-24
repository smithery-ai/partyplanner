import { describe, expect, it, vi } from "vitest";
import { createOAuthHandoffRoutes } from "../src/handoff";

describe("createOAuthHandoffRoutes", () => {
  it("uses the local dev app token fallback when exchanging broker handoffs", async () => {
    const originalEnv = process.env.HYLO_API_KEY;
    delete process.env.HYLO_API_KEY;

    const workflowRequests: Request[] = [];
    const workflowApp = {
      async fetch(request: Request): Promise<Response> {
        workflowRequests.push(request);
        return Response.json({ ok: true });
      },
    };

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        runId: "run_1",
        interventionId: "notion:oauth-callback",
        token: { accessToken: "notion-token" },
      }),
    );

    try {
      const app = createOAuthHandoffRoutes({
        workflowApp,
        workflowBasePath: "/api/workflow",
        brokerBaseUrl: "https://api-worker.hylo.localhost/oauth",
        providers: ["notion"],
      });

      const response = await app.request(
        "https://nextjs.hylo.localhost/notion/handoff?handoff=handoff_1",
      );

      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api-worker.hylo.localhost/oauth/notion/exchange",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer local-dev-hylo-api-key",
          }),
        }),
      );
      expect(workflowRequests).toHaveLength(1);
      expect(workflowRequests[0]?.url).toBe(
        "https://nextjs.hylo.localhost/api/workflow/runs/run_1/interventions/notion%3Aoauth-callback",
      );
      expect(await workflowRequests[0]?.json()).toEqual({
        payload: { accessToken: "notion-token" },
      });
    } finally {
      fetchMock.mockRestore();
      if (originalEnv === undefined) {
        delete process.env.HYLO_API_KEY;
      } else {
        process.env.HYLO_API_KEY = originalEnv;
      }
    }
  });
});
