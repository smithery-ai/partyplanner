import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type StoredAuth = {
  accessToken: string;
  backendUrl?: string;
  clientId: string;
  refreshToken?: string;
  workosApiBaseUrl?: string;
};

type AuthStore = {
  backends: Record<string, StoredAuth>;
};

const AUTH_PATH = join(configDir(), "hylo", "auth.json");

export async function readStoredAuth(
  backendUrl?: string,
): Promise<StoredAuth | undefined> {
  try {
    const parsed = JSON.parse(await readFile(AUTH_PATH, "utf8")) as unknown;
    const backendKey = backendUrl ? normalizeBackendUrl(backendUrl) : undefined;
    if (isAuthStore(parsed)) {
      if (backendKey) return parsed.backends[backendKey];
      const entries = Object.values(parsed.backends);
      return entries.length === 1 ? entries[0] : undefined;
    }
    if (!isStoredAuth(parsed)) return undefined;
    if (!backendKey) return parsed;
    return parsed.backendUrl &&
      normalizeBackendUrl(parsed.backendUrl) === backendKey
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

export async function writeStoredAuth(auth: StoredAuth): Promise<void> {
  await mkdir(dirname(AUTH_PATH), { recursive: true, mode: 0o700 });
  const backendKey = auth.backendUrl
    ? normalizeBackendUrl(auth.backendUrl)
    : undefined;
  const store = backendKey
    ? await readAuthStoreWithLegacyEntry()
    : { backends: {} };
  const value = backendKey
    ? {
        backends: {
          ...store.backends,
          [backendKey]: { ...auth, backendUrl: backendKey },
        },
      }
    : auth;
  await writeFile(AUTH_PATH, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
}

export async function clearStoredAuth(): Promise<void> {
  await rm(AUTH_PATH, { force: true });
}

export function authPath(): string {
  return AUTH_PATH;
}

function configDir(): string {
  return process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
}

async function readAuthStoreWithLegacyEntry(): Promise<AuthStore> {
  try {
    const parsed = JSON.parse(await readFile(AUTH_PATH, "utf8")) as unknown;
    if (isAuthStore(parsed)) return parsed;
    if (isStoredAuth(parsed) && parsed.backendUrl) {
      const backendKey = normalizeBackendUrl(parsed.backendUrl);
      return {
        backends: {
          [backendKey]: { ...parsed, backendUrl: backendKey },
        },
      };
    }
  } catch {
    // Start a fresh scoped auth store.
  }
  return { backends: {} };
}

function normalizeBackendUrl(value: string): string {
  return value.trim().replace(/\/+$/, "").toLowerCase();
}

function isAuthStore(value: unknown): value is AuthStore {
  return (
    typeof value === "object" &&
    value !== null &&
    "backends" in value &&
    typeof (value as { backends?: unknown }).backends === "object" &&
    (value as { backends?: unknown }).backends !== null
  );
}

function isStoredAuth(value: unknown): value is StoredAuth {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { accessToken?: unknown }).accessToken === "string" &&
    typeof (value as { clientId?: unknown }).clientId === "string"
  );
}
