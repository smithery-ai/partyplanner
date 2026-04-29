import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { createWorkOS, type PublicWorkOS, type User } from "@workos-inc/node";
import { safeStorage } from "electron";
import Store from "electron-store";
import type { AuthUser } from "../shared/auth";

const REDIRECT_URI = "hylo-auth://callback";
const PKCE_TTL_MS = 10 * 60 * 1000;
const PORTLESS_CA_PATH = "/tmp/portless/ca.pem";

type WorkOSClientConfig = {
  apiHostname: string;
  authkitHostname?: string;
  clientId: string;
};

type StoredSession = {
  accessToken: string;
  organizationId: string | null;
  refreshToken: string;
  user: AuthUser;
};

type StoreSchema = {
  pkce: {
    codeVerifier: string;
    expiresAt: number;
  } | null;
  session: string | null;
};

const store = new Store<StoreSchema>({
  name: "hylo-desktop-auth",
  defaults: {
    pkce: null,
    session: null,
  },
});

let workosConfigPromise: Promise<WorkOSClientConfig> | undefined;
let refreshSessionPromise: Promise<StoredSession | null> | undefined;

export async function getSignInUrl(
  options: { organizationId?: string } = {},
): Promise<string> {
  const { apiWorkOS, authkitWorkOS, config } = await loadWorkOS();
  const { codeVerifier, codeChallenge } = await apiWorkOS.pkce.generate();
  store.set("pkce", {
    codeVerifier,
    expiresAt: Date.now() + PKCE_TTL_MS,
  });
  return authkitWorkOS.userManagement.getAuthorizationUrl({
    clientId: config.clientId,
    redirectUri: REDIRECT_URI,
    codeChallenge,
    codeChallengeMethod: "S256",
    provider: "authkit",
    ...(options.organizationId
      ? { organizationId: options.organizationId }
      : {}),
  });
}

export async function handleCallback(code: string): Promise<AuthUser> {
  const pkce = store.get("pkce");
  if (!pkce) {
    throw new Error("No PKCE state found.");
  }
  if (pkce.expiresAt < Date.now()) {
    store.delete("pkce");
    throw new Error("PKCE verification expired.");
  }

  const { apiWorkOS, config } = await loadWorkOS();
  const auth = await apiWorkOS.userManagement.authenticateWithCode({
    clientId: config.clientId,
    code,
    codeVerifier: pkce.codeVerifier,
  });

  store.delete("pkce");
  const session = {
    accessToken: auth.accessToken,
    organizationId:
      auth.organizationId ?? organizationIdFromAccessToken(auth.accessToken),
    refreshToken: auth.refreshToken,
    user: toAuthUser(auth.user),
  } satisfies StoredSession;
  writeSession(session);
  return session.user;
}

export async function getUser(): Promise<AuthUser | null> {
  const session = await refreshSessionIfNeeded();
  return session?.user ?? null;
}

export async function getAccessToken(): Promise<string> {
  const session = await refreshSessionIfNeeded();
  if (!session?.accessToken) {
    throw new Error("You are not signed in.");
  }
  return session.accessToken;
}

export async function getOrganizationId(): Promise<string | null> {
  const session = await refreshSessionIfNeeded();
  return session?.organizationId ?? null;
}

export function clearSession(): void {
  store.delete("pkce");
  store.delete("session");
}

export async function getLogoutUrl(): Promise<string | null> {
  const sessionId = getSessionId(readSession());
  if (!sessionId) return null;
  const { authkitWorkOS } = await loadWorkOS();
  return authkitWorkOS.userManagement.getLogoutUrl({ sessionId });
}

async function refreshSessionIfNeeded(): Promise<StoredSession | null> {
  refreshSessionPromise ??= refreshSessionIfNeededOnce().finally(() => {
    refreshSessionPromise = undefined;
  });
  return refreshSessionPromise;
}

async function refreshSessionIfNeededOnce(): Promise<StoredSession | null> {
  const session = readSession();
  if (!session?.accessToken) return null;
  if (!isTokenExpired(session.accessToken)) return session;

  try {
    const { apiWorkOS, config } = await loadWorkOS();
    const refreshed =
      await apiWorkOS.userManagement.authenticateWithRefreshToken({
        clientId: config.clientId,
        refreshToken: session.refreshToken,
      });
    const nextSession = {
      accessToken: refreshed.accessToken,
      organizationId:
        refreshed.organizationId ??
        organizationIdFromAccessToken(refreshed.accessToken),
      refreshToken: refreshed.refreshToken,
      user: toAuthUser(refreshed.user),
    } satisfies StoredSession;
    writeSession(nextSession);
    return nextSession;
  } catch {
    clearSession();
    return null;
  }
}

function readSession(): StoredSession | null {
  const session = deserializeSession(store.get("session"));
  if (!session) return null;
  return {
    ...session,
    organizationId:
      session.organizationId ??
      organizationIdFromAccessToken(session.accessToken),
  };
}

function writeSession(session: StoredSession): void {
  store.set("session", serializeSession(session));
}

function serializeSession(session: StoredSession): string {
  const value = JSON.stringify(session);
  if (!safeStorage.isEncryptionAvailable()) {
    return `plain:${value}`;
  }
  return `enc:${safeStorage.encryptString(value).toString("base64")}`;
}

function deserializeSession(
  value: string | null | undefined,
): StoredSession | null {
  if (!value) return null;
  try {
    if (value.startsWith("enc:")) {
      if (!safeStorage.isEncryptionAvailable()) return null;
      return JSON.parse(
        safeStorage.decryptString(Buffer.from(value.slice(4), "base64")),
      ) as StoredSession;
    }
    const raw = value.startsWith("plain:") ? value.slice(6) : value;
    return JSON.parse(raw) as StoredSession;
  } catch {
    clearSession();
    return null;
  }
}

async function loadWorkOS(): Promise<{
  apiWorkOS: PublicWorkOS;
  authkitWorkOS: PublicWorkOS;
  config: WorkOSClientConfig;
}> {
  const config = await getWorkOSConfig();
  return {
    apiWorkOS: createWorkOS({
      clientId: config.clientId,
      apiHostname: config.apiHostname,
    }),
    authkitWorkOS: createWorkOS({
      clientId: config.clientId,
      ...(config.authkitHostname
        ? { apiHostname: config.authkitHostname }
        : {}),
    }),
    config,
  };
}

async function getWorkOSConfig(): Promise<WorkOSClientConfig> {
  workosConfigPromise ??= loadWorkOSConfig();
  return workosConfigPromise;
}

async function loadWorkOSConfig(): Promise<WorkOSClientConfig> {
  const clientId = optionalEnv(import.meta.env.MAIN_VITE_WORKOS_CLIENT_ID);
  const apiHostname = optionalEnv(
    import.meta.env.MAIN_VITE_WORKOS_API_HOSTNAME,
  );
  const authkitHostname = optionalEnv(
    import.meta.env.MAIN_VITE_WORKOS_AUTHKIT_HOSTNAME,
  );
  if (clientId) {
    return {
      clientId,
      apiHostname: apiHostname ?? "api.workos.com",
      authkitHostname,
    };
  }

  const response = await jsonGet<{
    auth?: { clientId?: string; apiHostname?: string } | null;
  }>(`${requireBackendUrl()}/auth/client-config`);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `Failed to load auth client config from backend (${response.status}).`,
    );
  }
  const payload = response.body;
  const auth = payload.auth;
  if (!auth?.clientId) {
    throw new Error("WorkOS AuthKit is not configured on this Hylo backend.");
  }

  return {
    clientId: auth.clientId,
    apiHostname: apiHostname ?? "api.workos.com",
    authkitHostname,
  };
}

function requireBackendUrl(): string {
  const backendUrl = optionalEnv(import.meta.env.MAIN_VITE_HYLO_BACKEND_URL);
  if (!backendUrl) {
    throw new Error("MAIN_VITE_HYLO_BACKEND_URL is required for desktop auth.");
  }
  return backendUrl.replace(/\/+$/, "");
}

function optionalEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function toAuthUser(user: User): AuthUser {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName ?? null,
    lastName: user.lastName ?? null,
    profilePictureUrl: user.profilePictureUrl ?? null,
  };
}

function getSessionId(session: StoredSession | null): string | null {
  if (!session?.accessToken) return null;
  try {
    const payload = decodeJwtPayload(session.accessToken) as { sid?: unknown };
    return typeof payload.sid === "string" ? payload.sid : null;
  } catch {
    return null;
  }
}

function organizationIdFromAccessToken(accessToken: string): string | null {
  try {
    const payload = decodeJwtPayload(accessToken) as {
      org_id?: unknown;
      organization_id?: unknown;
    };
    if (typeof payload.org_id === "string") return payload.org_id;
    if (typeof payload.organization_id === "string") {
      return payload.organization_id;
    }
    return null;
  } catch {
    return null;
  }
}

function isTokenExpired(accessToken: string): boolean {
  try {
    const payload = decodeJwtPayload(accessToken) as { exp?: unknown };
    return (
      typeof payload.exp !== "number" || Date.now() > payload.exp * 1000 - 10000
    );
  } catch {
    return true;
  }
}

function decodeJwtPayload(token: string): unknown {
  const [, payload = ""] = token.split(".");
  const normalized = payload
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(payload.length / 4) * 4, "=");
  return JSON.parse(Buffer.from(normalized, "base64").toString("utf8"));
}

async function jsonGet<T>(url: string): Promise<{ status: number; body: T }> {
  const requestUrl = new URL(url);
  const transport = requestUrl.protocol === "https:" ? https : http;
  const agent = requestAgent(requestUrl);

  return new Promise((resolve, reject) => {
    const request = transport.request(
      requestUrl,
      {
        method: "GET",
        headers: { Accept: "application/json" },
        ...(agent ? { agent } : {}),
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          try {
            resolve({
              status: response.statusCode ?? 0,
              body: text ? (JSON.parse(text) as T) : ({} as T),
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

function requestAgent(url: URL): http.Agent | https.Agent | undefined {
  if (url.protocol !== "https:") return undefined;
  if (!isLocalTlsHost(url.hostname)) return undefined;

  const ca = readPortlessCa();
  return new https.Agent(
    ca
      ? { ca }
      : {
          // Development fallback when the portless CA has not been exported
          // into the current process environment.
          rejectUnauthorized: false,
        },
  );
}

function isLocalTlsHost(hostname: string): boolean {
  return hostname.endsWith(".local") || hostname.endsWith(".localhost");
}

function readPortlessCa(): Buffer | undefined {
  try {
    return fs.readFileSync(PORTLESS_CA_PATH);
  } catch {
    return undefined;
  }
}
