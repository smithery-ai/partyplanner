import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const backendUrl = "https://backend.flamecast.dev";

let previousConfigHome: string | undefined;
let configHome: string;

beforeEach(async () => {
  previousConfigHome = process.env.XDG_CONFIG_HOME;
  configHome = await mkdtemp(join(tmpdir(), "hylo-list-"));
  process.env.XDG_CONFIG_HOME = configHome;
  vi.resetModules();
  vi.restoreAllMocks();
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (previousConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = previousConfigHome;
  }
  await rm(configHome, { force: true, recursive: true });
});

it("lists organizations for the signed-in user", async () => {
  const { writeStoredAuth } = await import("../src/auth-store.js");
  const { runOrganizations } = await import("../src/commands/organizations.js");
  await writeStoredAuth({
    accessToken: validJwt(),
    backendUrl,
    clientId: "client_test",
  });
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url =
      typeof input === "string" || input instanceof URL
        ? input.toString()
        : input.url;
    expect(url).toBe(`${backendUrl}/me/organizations`);
    return Response.json({
      organizations: [
        {
          id: "org_1",
          membershipId: "om_1",
          name: "Acme",
          role: "admin",
          status: "active",
        },
      ],
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  const stdout = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);

  await expect(runOrganizations(["list"])).resolves.toBe(0);

  expect(fetchMock).toHaveBeenCalledOnce();
  expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toEqual({
    organizations: [
      {
        id: "org_1",
        membershipId: "om_1",
        name: "Acme",
        role: "admin",
        status: "active",
      },
    ],
  });
});

it("lists workers for an organization", async () => {
  const { runWorkers } = await import("../src/commands/workers.js");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === "string" || input instanceof URL
          ? input.toString()
          : input.url;
      expect(url).toBe(`${backendUrl}/tenants/org_1/deployments`);
      return Response.json({
        ok: true,
        tenantId: "org_1",
        deployments: [
          {
            createdAt: 1,
            deploymentId: "worker-1",
            dispatchNamespace: "local",
            tags: [],
            tenantId: "org_1",
            updatedAt: 1,
          },
        ],
      });
    }),
  );
  const stdout = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);

  await expect(
    runWorkers(["list", "--api-key", "admin-key", "--organization", "org_1"]),
  ).resolves.toBe(0);

  expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toEqual({
    ok: true,
    organizationId: "org_1",
    workers: [
      {
        createdAt: 1,
        deploymentId: "worker-1",
        dispatchNamespace: "local",
        tags: [],
        tenantId: "org_1",
        updatedAt: 1,
      },
    ],
  });
});

it("targets runs by worker and organization", async () => {
  const { runRuns } = await import("../src/commands/runs.js");
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url =
      typeof input === "string" || input instanceof URL
        ? input.toString()
        : input.url;
    if (url === `${backendUrl}/tenants/org_1/deployments`) {
      return Response.json({
        ok: true,
        tenantId: "org_1",
        deployments: [
          {
            createdAt: 1,
            deploymentId: "worker-1",
            dispatchNamespace: "local",
            tags: [],
            tenantId: "org_1",
            updatedAt: 1,
            workflowApiUrl: "/workers/worker-1/api/workflow",
          },
        ],
      });
    }
    expect(url).toBe(`${backendUrl}/workers/worker-1/api/workflow/runs`);
    return Response.json([{ runId: "run_1", status: "completed" }]);
  });
  vi.stubGlobal("fetch", fetchMock);
  const stdout = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);

  await expect(
    runRuns([
      "list",
      "--api-key",
      "admin-key",
      "--organization",
      "org_1",
      "--worker",
      "worker-1",
    ]),
  ).resolves.toBe(0);

  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toEqual([
    { runId: "run_1", status: "completed" },
  ]);
});

function validJwt(): string {
  return [
    base64url({ alg: "none", typ: "JWT" }),
    base64url({ exp: Math.floor(Date.now() / 1000) + 60 * 60 }),
    "",
  ].join(".");
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
