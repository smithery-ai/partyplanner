import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runAuth } from "../src/commands/auth.js";

let previousConfigHome: string | undefined;
let configHome: string;

beforeEach(async () => {
  previousConfigHome = process.env.XDG_CONFIG_HOME;
  configHome = await mkdtemp(join(tmpdir(), "hylo-auth-"));
  process.env.XDG_CONFIG_HOME = configHome;
  vi.useFakeTimers();
  vi.restoreAllMocks();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (previousConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = previousConfigHome;
  }
  await rm(configHome, { force: true, recursive: true });
});

it("prefers the backend CLI WorkOS hostname for device authorization", async () => {
  const backendUrl = "https://backend.example.com";
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url =
      typeof input === "string" || input instanceof URL
        ? input.toString()
        : input.url;
    if (url === `${backendUrl}/auth/client-config`) {
      return Response.json({
        auth: {
          provider: "workos",
          clientId: "client_test",
          apiHostname: "auth.example.com",
          cliApiHostname: "api.workos.com",
        },
        api: { baseUrl: backendUrl },
        features: { cliAuth: true, deployments: true },
      });
    }
    if (url === "https://api.workos.com/user_management/authorize/device") {
      return Response.json({
        device_code: "device-code",
        user_code: "USER-CODE",
        verification_uri: "https://example.com/verify",
        expires_in: 60,
        interval: 1,
      });
    }
    if (url === "https://api.workos.com/user_management/authenticate") {
      return Response.json({
        access_token: "access-token",
        refresh_token: "refresh-token",
      });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  const authPromise = runAuth(["login", "--backend", backendUrl]);
  await vi.advanceTimersByTimeAsync(1_000);

  await expect(authPromise).resolves.toBe(0);
  expect(fetchMock).toHaveBeenNthCalledWith(
    2,
    "https://api.workos.com/user_management/authorize/device",
    expect.anything(),
  );
  expect(fetchMock).toHaveBeenNthCalledWith(
    3,
    "https://api.workos.com/user_management/authenticate",
    expect.anything(),
  );
});

it("falls back to api.workos.com when backend auth config only exposes a browser hostname", async () => {
  const backendUrl = "https://backend.example.com";
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url =
      typeof input === "string" || input instanceof URL
        ? input.toString()
        : input.url;
    if (url === `${backendUrl}/auth/client-config`) {
      return Response.json({
        auth: {
          provider: "workos",
          clientId: "client_test",
          apiHostname: "auth.example.com",
        },
        api: { baseUrl: backendUrl },
        features: { cliAuth: true, deployments: true },
      });
    }
    if (url === "https://api.workos.com/user_management/authorize/device") {
      return Response.json({
        device_code: "device-code",
        user_code: "USER-CODE",
        verification_uri: "https://example.com/verify",
        expires_in: 60,
        interval: 1,
      });
    }
    if (url === "https://api.workos.com/user_management/authenticate") {
      return Response.json({
        access_token: "access-token",
        refresh_token: "refresh-token",
      });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  const authPromise = runAuth(["login", "--backend", backendUrl]);
  await vi.advanceTimersByTimeAsync(1_000);

  await expect(authPromise).resolves.toBe(0);
  expect(fetchMock).toHaveBeenNthCalledWith(
    2,
    "https://api.workos.com/user_management/authorize/device",
    expect.anything(),
  );
  expect(fetchMock).toHaveBeenNthCalledWith(
    3,
    "https://api.workos.com/user_management/authenticate",
    expect.anything(),
  );
});

it("reports an unreachable backend with a local-dev hint", async () => {
  const backendUrl = "http://127.0.0.1:8787";
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new TypeError("fetch failed");
    }),
  );
  const stderr = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(() => true);

  await expect(runAuth(["login", "--backend-url", backendUrl])).resolves.toBe(
    1,
  );
  expect(stderr).toHaveBeenCalledWith(
    `Could not reach Hylo backend at ${backendUrl}. Start the local backend with \`pnpm dev\`, or use a reachable --backend-url.\n`,
  );
});
