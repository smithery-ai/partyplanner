import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let previousConfigHome: string | undefined;
let configHome: string;

beforeEach(async () => {
  previousConfigHome = process.env.XDG_CONFIG_HOME;
  configHome = await mkdtemp(join(tmpdir(), "hylo-auth-store-"));
  process.env.XDG_CONFIG_HOME = configHome;
  vi.resetModules();
});

afterEach(async () => {
  if (previousConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = previousConfigHome;
  }
  await rm(configHome, { force: true, recursive: true });
  vi.resetModules();
});

it("scopes stored auth by normalized backend URL", async () => {
  const store = await import("../src/auth-store.js");

  await store.writeStoredAuth({
    accessToken: "local-token",
    backendUrl: "HTTP://127.0.0.1:8787/",
    clientId: "client-local",
  });
  await store.writeStoredAuth({
    accessToken: "prod-token",
    backendUrl: "https://api.example.com/",
    clientId: "client-prod",
  });

  await expect(
    store.readStoredAuth("http://127.0.0.1:8787"),
  ).resolves.toMatchObject({
    accessToken: "local-token",
    backendUrl: "http://127.0.0.1:8787",
    clientId: "client-local",
  });
  await expect(
    store.readStoredAuth("https://api.example.com"),
  ).resolves.toMatchObject({
    accessToken: "prod-token",
    backendUrl: "https://api.example.com",
    clientId: "client-prod",
  });
  await expect(
    store.readStoredAuth("http://127.0.0.1:9999"),
  ).resolves.toBeUndefined();

  const raw = JSON.parse(
    await readFile(join(configHome, "hylo", "auth.json"), "utf8"),
  ) as {
    backends: Record<string, { backendUrl: string }>;
  };
  expect(raw.backends["http://127.0.0.1:8787"].backendUrl).toBe(
    "http://127.0.0.1:8787",
  );
});

it("does not reuse a legacy unscoped token for an explicit backend", async () => {
  const store = await import("../src/auth-store.js");

  await store.writeStoredAuth({
    accessToken: "legacy-token",
    clientId: "client-legacy",
  });

  await expect(store.readStoredAuth()).resolves.toMatchObject({
    accessToken: "legacy-token",
    clientId: "client-legacy",
  });
  await expect(
    store.readStoredAuth("http://127.0.0.1:8787"),
  ).resolves.toBeUndefined();
});
