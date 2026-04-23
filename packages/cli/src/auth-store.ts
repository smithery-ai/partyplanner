import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type StoredAuth = {
  accessToken: string;
  clientId: string;
  refreshToken?: string;
  workosApiBaseUrl?: string;
};

const AUTH_PATH = join(configDir(), "hylo", "auth.json");

export async function readStoredAuth(): Promise<StoredAuth | undefined> {
  try {
    return JSON.parse(await readFile(AUTH_PATH, "utf8")) as StoredAuth;
  } catch {
    return undefined;
  }
}

export async function writeStoredAuth(auth: StoredAuth): Promise<void> {
  await mkdir(dirname(AUTH_PATH), { recursive: true, mode: 0o700 });
  await writeFile(AUTH_PATH, `${JSON.stringify(auth, null, 2)}\n`, {
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
