import {
  type AuthClientConfig,
  createHyloApiClient,
  HyloApiError,
} from "@hylo/api-client";
import {
  clearStoredAuth,
  readStoredAuth,
  writeStoredAuth,
} from "../auth-store.js";
import { resolveHyloBackendUrl } from "../config.js";

type AuthOptions = {
  backendUrl?: string;
  clientId?: string;
  workosApiHostname?: string;
  workosApiBaseUrl?: string;
};

type DeviceAuthorizationResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
};

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
};

type AccessTokenOptions = {
  backendUrl?: string;
};

const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const DEFAULT_WORKOS_API_BASE_URL = "https://api.workos.com";

const HELP = `hylo auth

Usage:
  hylo auth login
  hylo auth token
  hylo auth logout

Options:
  --backend <url>         Hylo backend API URL
  --client-id <id>        WorkOS AuthKit client ID
  --workos-api-hostname <host>
                          WorkOS Authentication API hostname
  --workos-api <url>      WorkOS API origin override
`;

export async function runAuth(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return 0;
  }

  try {
    switch (command) {
      case "login":
        await login(rest);
        return 0;
      case "token":
        await printToken(rest);
        return 0;
      case "logout":
        await clearStoredAuth();
        process.stdout.write("Signed out of Hylo.\n");
        return 0;
      default:
        process.stderr.write(`Unknown auth command: ${command}\n\n${HELP}`);
        return 1;
    }
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

export async function getHyloAccessToken({
  backendUrl,
}: AccessTokenOptions = {}): Promise<string | undefined> {
  const stored = await readStoredAuth(backendUrl);
  if (!stored) return undefined;
  if (!isJwtExpired(stored.accessToken)) return stored.accessToken;
  if (!stored.refreshToken) return stored.accessToken;

  const token = await refreshAccessToken({
    clientId: stored.clientId,
    refreshToken: stored.refreshToken,
    workosApiBaseUrl: stored.workosApiBaseUrl,
  });
  await writeStoredAuth({
    accessToken: token.access_token,
    backendUrl: stored.backendUrl,
    clientId: stored.clientId,
    refreshToken: token.refresh_token ?? stored.refreshToken,
    workosApiBaseUrl: stored.workosApiBaseUrl,
  });
  return token.access_token;
}

async function login(args: string[]): Promise<void> {
  const options = parseAuthOptions(args);
  if (options.rest.length > 0) {
    throw new Error(`Unexpected argument: ${options.rest[0]}`);
  }
  const backendUrl = resolveHyloBackendUrl(options.backendUrl);
  const configuredClientId =
    options.clientId ??
    process.env.WORKOS_CLIENT_ID ??
    process.env.VITE_WORKOS_CLIENT_ID;
  const configuredApiHostname =
    options.workosApiHostname ??
    process.env.WORKOS_API_HOSTNAME ??
    process.env.VITE_WORKOS_API_HOSTNAME;
  const clientConfig: Partial<AuthClientConfig> =
    configuredClientId && (configuredApiHostname || options.workosApiBaseUrl)
      ? {}
      : await fetchAuthClientConfig(backendUrl);
  const clientId = requireValue(
    configuredClientId ?? clientConfig.auth?.clientId,
    "WorkOS client ID from /auth/client-config or --client-id",
  );
  const workosApiBaseUrl = resolveWorkOSApiBaseUrl(
    options,
    clientConfig.auth?.apiHostname,
  );
  const device = await requestDeviceAuthorization({
    clientId,
    workosApiBaseUrl,
  });

  process.stdout.write(
    [
      "Complete Hylo sign-in in your browser:",
      `  ${device.verification_uri_complete ?? device.verification_uri}`,
      "",
      `Code: ${device.user_code}`,
      "",
    ].join("\n"),
  );

  const token = await pollDeviceToken({
    clientId,
    device,
    workosApiBaseUrl,
  });
  await writeStoredAuth({
    accessToken: token.access_token,
    backendUrl,
    clientId,
    refreshToken: token.refresh_token,
    workosApiBaseUrl,
  });
  process.stdout.write("Signed in to Hylo.\n");
}

async function printToken(args: string[]): Promise<void> {
  const options = parseAuthOptions(args);
  const rest = options.rest;
  if (rest.length > 0) throw new Error(`Unexpected argument: ${rest[0]}`);
  const backendUrl = options.backendUrl
    ? resolveHyloBackendUrl(options.backendUrl)
    : undefined;
  const token = await getHyloAccessToken({ backendUrl });
  if (!token) {
    throw new Error(
      `Not signed in${backendUrl ? ` for ${backendUrl}` : ""}. Run \`hylo auth login${backendUrl ? ` --backend-url ${backendUrl}` : ""}\` first.`,
    );
  }
  process.stdout.write(`${token}\n`);
}

async function requestDeviceAuthorization({
  clientId,
  workosApiBaseUrl,
}: {
  clientId: string;
  workosApiBaseUrl: string;
}): Promise<DeviceAuthorizationResponse> {
  const endpoints = resolveWorkOSEndpoints(workosApiBaseUrl);
  const response = await fetch(endpoints.deviceAuthorizationUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formBody({ client_id: clientId }),
  });
  return parseResponse<DeviceAuthorizationResponse>(response);
}

async function fetchAuthClientConfig(
  backendUrl: string,
): Promise<AuthClientConfig> {
  try {
    return await createHyloApiClient({
      baseUrl: backendUrl,
    }).auth.clientConfig();
  } catch (e) {
    if (e instanceof HyloApiError) {
      const message =
        isRecord(e.error) && typeof e.error.message === "string"
          ? e.error.message
          : `HTTP ${e.response.status}`;
      throw new Error(`Hylo auth config request failed: ${message}`);
    }
    throw e;
  }
}

async function pollDeviceToken({
  clientId,
  device,
  workosApiBaseUrl,
}: {
  clientId: string;
  device: DeviceAuthorizationResponse;
  workosApiBaseUrl: string;
}): Promise<TokenResponse> {
  const endpoints = resolveWorkOSEndpoints(workosApiBaseUrl);
  const startedAt = Date.now();
  let intervalMs = Math.max(device.interval ?? 5, 1) * 1000;
  const expiresAt = startedAt + device.expires_in * 1000;

  while (Date.now() < expiresAt) {
    await sleep(intervalMs);
    const response = await fetch(endpoints.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody({
        client_id: clientId,
        device_code: device.device_code,
        grant_type: DEVICE_GRANT_TYPE,
      }),
    });

    const payload = await response.json().catch(() => ({}));
    if (response.ok) return payload as TokenResponse;
    const error = isRecord(payload) ? payload.error : undefined;
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      intervalMs += 5000;
      continue;
    }
    throw new Error(
      typeof error === "string"
        ? `Authorization failed: ${error}`
        : "Authorization failed.",
    );
  }

  throw new Error("Authorization timed out.");
}

async function refreshAccessToken({
  clientId,
  refreshToken,
  workosApiBaseUrl = DEFAULT_WORKOS_API_BASE_URL,
}: {
  clientId: string;
  refreshToken: string;
  workosApiBaseUrl?: string;
}): Promise<TokenResponse> {
  const endpoints = resolveWorkOSEndpoints(workosApiBaseUrl);
  const response = await fetch(endpoints.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formBody({
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  return parseResponse<TokenResponse>(response);
}

async function parseResponse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : `HTTP ${response.status}`;
    throw new Error(`WorkOS request failed: ${message}`);
  }
  return payload as T;
}

function parseAuthOptions(args: string[]): AuthOptions & { rest: string[] } {
  const options: AuthOptions & { rest: string[] } = { rest: [] };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--client-id") {
      options.clientId = requireArgValue(args, ++index, arg);
    } else if (arg.startsWith("--client-id=")) {
      options.clientId = arg.slice("--client-id=".length);
    } else if (arg === "--backend" || arg === "--backend-url") {
      options.backendUrl = requireArgValue(args, ++index, arg);
    } else if (arg.startsWith("--backend=")) {
      options.backendUrl = arg.slice("--backend=".length);
    } else if (arg.startsWith("--backend-url=")) {
      options.backendUrl = arg.slice("--backend-url=".length);
    } else if (arg === "--workos-api-hostname") {
      options.workosApiHostname = requireArgValue(args, ++index, arg);
    } else if (arg.startsWith("--workos-api-hostname=")) {
      options.workosApiHostname = arg.slice("--workos-api-hostname=".length);
    } else if (arg === "--workos-api") {
      options.workosApiBaseUrl = requireArgValue(args, ++index, arg);
    } else if (arg.startsWith("--workos-api=")) {
      options.workosApiBaseUrl = arg.slice("--workos-api=".length);
    } else {
      options.rest.push(arg);
    }
  }
  return options;
}

function resolveWorkOSApiBaseUrl(
  options: AuthOptions,
  configuredApiHostname: string | undefined,
): string {
  const explicitUrl =
    options.workosApiBaseUrl ?? process.env.WORKOS_API_BASE_URL;
  if (explicitUrl) return explicitUrl.replace(/\/+$/, "");
  const hostname =
    options.workosApiHostname ??
    process.env.WORKOS_API_HOSTNAME ??
    process.env.VITE_WORKOS_API_HOSTNAME ??
    configuredApiHostname;
  if (!hostname) return DEFAULT_WORKOS_API_BASE_URL;
  if (/^https?:\/\//i.test(hostname)) return hostname.replace(/\/+$/, "");
  return `https://${hostname.replace(/^\/+|\/+$/g, "")}`;
}

function resolveWorkOSEndpoints(workosApiBaseUrl: string): {
  deviceAuthorizationUrl: string;
  tokenUrl: string;
} {
  const baseUrl = workosApiBaseUrl.replace(/\/+$/, "");
  const hostname = new URL(baseUrl).hostname;
  if (hostname === "api.workos.com") {
    return {
      deviceAuthorizationUrl: `${baseUrl}/user_management/authorize/device`,
      tokenUrl: `${baseUrl}/user_management/authenticate`,
    };
  }
  return {
    deviceAuthorizationUrl: `${baseUrl}/oauth2/device_authorization`,
    tokenUrl: `${baseUrl}/oauth2/token`,
  };
}

function formBody(values: Record<string, string>): URLSearchParams {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) body.set(key, value);
  return body;
}

function isJwtExpired(token: string): boolean {
  try {
    const [, payload] = token.split(".");
    if (!payload) return true;
    const decoded = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    const exp =
      isRecord(decoded) && typeof decoded.exp === "number"
        ? decoded.exp
        : undefined;
    return exp ? exp * 1000 <= Date.now() + 30_000 : true;
  } catch {
    return true;
  }
}

function requireValue(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${name} is required.`);
  return trimmed;
}

function requireArgValue(
  args: string[],
  index: number,
  option: string,
): string {
  const value = args[index];
  if (!value) throw new Error(`${option} requires a value.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
