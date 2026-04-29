import { createHmac } from "node:crypto";
import { createInMemoryBrokerStore } from "@workflow/oauth-broker";
import type { WorkflowPostgresDb } from "@workflow/postgres";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBackendApp } from "../src/app";
import type { DeploymentBackend } from "../src/deployments/backend";
import type {
  ProviderInstallationLookup,
  ProviderInstallationRecord,
  ProviderInstallationRegistry,
} from "../src/webhooks/registry";

const API_KEY = "test-api-key";
const SIGNING_SECRET = "test-signing-secret";

describe("slack webhook routing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers Slack installs from OAuth callback and forwards Events API payloads to the mapped worker", async () => {
    const providerInstallations = new MemoryProviderInstallationRegistry();

    const forwardedBodies: unknown[] = [];
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = asRequest(input, init);
        if (request.url === "https://slack.com/api/oauth.v2.access") {
          return Response.json({
            ok: true,
            access_token: "xoxb-test",
            token_type: "bot",
            scope: "chat:write",
            app_id: "A123",
            team: { id: "T123", name: "Acme" },
          });
        }

        if (
          request.url ===
          "http://backend.test/workers/customer-worker/api/workflow/webhooks"
        ) {
          forwardedBodies.push(JSON.parse(await request.text()));
          return Response.json({ ok: true });
        }

        throw new Error(`Unexpected fetch: ${request.url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const app = createBackendApp({
      db: fakeDb(),
      env: {
        HYLO_API_KEY: API_KEY,
        SLACK_CLIENT_ID: "client",
        SLACK_CLIENT_SECRET: "secret",
        SLACK_SIGNING_SECRET: SIGNING_SECRET,
      },
      oauthBrokerStore: createInMemoryBrokerStore(),
      providerInstallations,
    });

    const startResponse = await app.request(
      "http://backend.test/oauth/slack/start",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          runtimeHandoffUrl:
            "http://backend.test/workers/customer-worker/api/workflow/integrations/slack/handoff",
          runId: "run_oauth",
          interventionId: "oauth-callback",
        }),
      },
    );
    expect(startResponse.status).toBe(200);
    const startBody = (await startResponse.json()) as { authorizeUrl: string };
    const state = new URL(startBody.authorizeUrl).searchParams.get("state");
    expect(state).toBeTruthy();

    const callbackResponse = await app.request(
      `http://backend.test/oauth/slack/callback?state=${encodeURIComponent(
        state ?? "",
      )}&code=test-code`,
    );
    expect(callbackResponse.status).toBe(302);
    expect(
      await providerInstallations.find({
        providerId: "slack",
        anyOf: { teamId: "T123" },
        allOf: { appId: "A123" },
      }),
    ).toMatchObject({
      providerId: "slack",
      deploymentId: "customer-worker",
      identity: { teamId: "T123", appId: "A123" },
    });

    const rawBody = JSON.stringify({
      type: "event_callback",
      api_app_id: "A123",
      team_id: "T123",
      event_id: "Ev1",
      event_time: 123,
      event: {
        type: "app_mention",
        text: "hello",
      },
    });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const webhookResponse = await app.request(
      "http://backend.test/integrations/slack/events",
      {
        method: "POST",
        headers: signedSlackHeaders(timestamp, rawBody),
        body: rawBody,
      },
    );

    expect(webhookResponse.status).toBe(200);
    expect(forwardedBodies).toEqual([
      {
        payload: {
          source: "slack",
          kind: "event_callback",
          teamId: "T123",
          appId: "A123",
          eventId: "Ev1",
          eventTime: 123,
          payload: {
            type: "event_callback",
            api_app_id: "A123",
            team_id: "T123",
            event_id: "Ev1",
            event_time: 123,
            event: {
              type: "app_mention",
              text: "hello",
            },
          },
        },
      },
    ]);
  });

  it("extracts runId from interactive payload metadata before forwarding to the worker", async () => {
    const providerInstallations = new MemoryProviderInstallationRegistry();
    await providerInstallations.upsert({
      installationKey: "team:T123:app:A123",
      providerId: "slack",
      deploymentId: "customer-worker",
      identity: { teamId: "T123", appId: "A123" },
      runtimeHandoffUrl:
        "https://customer-worker.localhost/api/workflow/integrations/slack/handoff",
    });

    let forwardedBody: unknown;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = asRequest(input, init);
        if (
          request.url ===
          "https://customer-worker.localhost/api/workflow/webhooks"
        ) {
          forwardedBody = JSON.parse(await request.text());
          return Response.json({ ok: true });
        }
        throw new Error(`Unexpected fetch: ${request.url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const app = createBackendApp({
      db: fakeDb(),
      env: {
        HYLO_API_KEY: API_KEY,
        SLACK_SIGNING_SECRET: SIGNING_SECRET,
      },
      providerInstallations,
    });

    const interactivePayload = {
      type: "view_submission",
      api_app_id: "A123",
      team: { id: "T123" },
      view: {
        private_metadata: JSON.stringify({ runId: "run_waiting" }),
      },
    };
    const rawBody = new URLSearchParams({
      payload: JSON.stringify(interactivePayload),
    }).toString();
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const response = await app.request(
      "http://backend.test/integrations/slack/events",
      {
        method: "POST",
        headers: signedSlackHeaders(
          timestamp,
          rawBody,
          "application/x-www-form-urlencoded",
        ),
        body: rawBody,
      },
    );

    expect(response.status).toBe(200);
    expect(forwardedBody).toEqual({
      runId: "run_waiting",
      payload: {
        source: "slack",
        kind: "interactive",
        teamId: "T123",
        appId: "A123",
        payload: interactivePayload,
      },
    });
  });

  it("dispatches Slack events directly to configured tenant workers", async () => {
    const providerInstallations = new MemoryProviderInstallationRegistry();
    await providerInstallations.upsert({
      installationKey: "team:T123:app:A123",
      providerId: "slack",
      deploymentId: "customer-worker",
      identity: { teamId: "T123", appId: "A123" },
      runtimeHandoffUrl:
        "https://hylo-backend.test/workers/customer-worker/api/workflow/integrations/slack/handoff",
    });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    let dispatched:
      | { deploymentId: string; url: string; body: unknown }
      | undefined;
    const app = createBackendApp({
      db: fakeDb(),
      env: {
        HYLO_API_KEY: API_KEY,
        SLACK_SIGNING_SECRET: SIGNING_SECRET,
      },
      deploymentBackend: fakeDeploymentBackend(
        async (deploymentId, request) => {
          dispatched = {
            deploymentId,
            url: request.url,
            body: JSON.parse(await request.text()),
          };
          return Response.json({ ok: true });
        },
      ),
      providerInstallations,
    });

    const rawBody = JSON.stringify({
      type: "event_callback",
      api_app_id: "A123",
      team_id: "T123",
      event_id: "Ev1",
      event: {
        type: "app_mention",
        text: "hello",
      },
    });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const response = await app.request(
      "https://hylo-backend.test/integrations/slack/events",
      {
        method: "POST",
        headers: signedSlackHeaders(timestamp, rawBody),
        body: rawBody,
      },
    );

    expect(response.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    if (!dispatched) throw new Error("Expected direct worker dispatch.");
    expect(dispatched).toMatchObject({
      deploymentId: "customer-worker",
      url: "https://hylo-backend.test/workers/customer-worker/api/workflow/webhooks",
      body: {
        payload: {
          source: "slack",
          kind: "event_callback",
          teamId: "T123",
          appId: "A123",
          eventId: "Ev1",
        },
      },
    });
  });

  it("answers Slack URL verification challenges without forwarding to a worker", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const app = createBackendApp({
      db: fakeDb(),
      env: {
        HYLO_API_KEY: API_KEY,
        SLACK_SIGNING_SECRET: SIGNING_SECRET,
      },
      providerInstallations: new MemoryProviderInstallationRegistry(),
    });

    const rawBody = JSON.stringify({
      type: "url_verification",
      challenge: "challenge-token",
    });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const response = await app.request(
      "http://backend.test/integrations/slack/events",
      {
        method: "POST",
        headers: signedSlackHeaders(timestamp, rawBody),
        body: rawBody,
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/text\/plain/);
    expect(await response.text()).toBe("challenge-token");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects Slack requests with invalid signatures", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const app = createBackendApp({
      db: fakeDb(),
      env: {
        HYLO_API_KEY: API_KEY,
        SLACK_SIGNING_SECRET: SIGNING_SECRET,
      },
      providerInstallations: new MemoryProviderInstallationRegistry(),
    });

    const rawBody = JSON.stringify({
      type: "event_callback",
      api_app_id: "A123",
      team_id: "T123",
    });
    const response = await app.request(
      "http://backend.test/integrations/slack/events",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-slack-request-timestamp": Math.floor(Date.now() / 1000).toString(),
          "x-slack-signature": "v0=bad",
        },
        body: rawBody,
      },
    );

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

class MemoryProviderInstallationRegistry
  implements ProviderInstallationRegistry
{
  private readonly installations = new Map<
    string,
    ProviderInstallationRecord
  >();

  async find(
    lookup: ProviderInstallationLookup,
  ): Promise<ProviderInstallationRecord | undefined> {
    const matches = Array.from(this.installations.values()).filter(
      (installation) => {
        if (installation.providerId !== lookup.providerId) return false;
        const matchesAny = Object.entries(lookup.anyOf).some(
          ([key, value]) =>
            value !== undefined && installation.identity[key] === value,
        );
        if (!matchesAny) return false;
        for (const [key, value] of Object.entries(lookup.allOf ?? {})) {
          if (!value) continue;
          if (installation.identity[key] !== value) return false;
        }
        return true;
      },
    );
    return matches.sort((left, right) => right.updatedAt - left.updatedAt)[0];
  }

  async upsert(
    installation: Omit<ProviderInstallationRecord, "createdAt" | "updatedAt">,
  ): Promise<void> {
    const current = this.installations.get(installation.installationKey);
    const now = Date.now();
    this.installations.set(installation.installationKey, {
      ...installation,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    });
  }

  async list(providerId: string): Promise<ProviderInstallationRecord[]> {
    return Array.from(this.installations.values())
      .filter((record) => record.providerId === providerId)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async deleteByKey(installationKey: string): Promise<boolean> {
    return this.installations.delete(installationKey);
  }
}

function fakeDb(): WorkflowPostgresDb {
  return {} as WorkflowPostgresDb;
}

function fakeDeploymentBackend(
  fetchWorkflow: DeploymentBackend["fetchWorkflow"],
): DeploymentBackend {
  return {
    namespace: "test-namespace",
    configured: true,
    config: {
      accountId: "account",
      apiBaseUrl: "https://api.cloudflare.test",
      apiToken: "token",
      dispatchNamespace: "test-namespace",
      defaultCompatibilityDate: "2026-04-19",
    },
    resolveWorkflowApiUrl: () => undefined,
    create: async () => null,
    list: async () => ({ deployments: [] }),
    get: async () => null,
    delete: async () => null,
    deleteMany: async () => null,
    fetchWorkflow,
  };
}

function signedSlackHeaders(
  timestamp: string,
  rawBody: string,
  contentType = "application/json",
): Record<string, string> {
  return {
    "Content-Type": contentType,
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": signSlackRequest(timestamp, rawBody),
  };
}

function signSlackRequest(timestamp: string, rawBody: string): string {
  return `v0=${createHmac("sha256", SIGNING_SECRET)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex")}`;
}

function asRequest(input: RequestInfo | URL, init?: RequestInit): Request {
  return input instanceof Request ? input : new Request(input, init);
}
