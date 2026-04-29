import type { Context } from "hono";
import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";
import { PlatformApiError } from "../errors";
import type { BackendAppEnv } from "../types";

export type AuthContext =
  | { kind: "admin" }
  | {
      kind: "workos";
      tenantId: string;
      userId: string;
      role?: string;
      permissions: string[];
    };

export type WorkOSUserAuthContext = {
  kind: "workos";
  tenantId?: string;
  userId: string;
  role?: string;
  permissions: string[];
};

type WorkOSAccessTokenClaims = JWTPayload & {
  org_id?: string;
  permissions?: unknown;
  role?: unknown;
};

type WorkOSAuthConfig = {
  issuer?: string | string[];
  jwksUrl: string;
};

export async function authenticateRequest(
  c: Context,
  env: BackendAppEnv,
  apiKey: string,
): Promise<AuthContext | undefined> {
  const token = bearerToken(c);
  if (!token) return undefined;
  if (token === apiKey) return { kind: "admin" };
  return authenticateWorkOSToken(env, token);
}

export async function authenticateWorkOSUserRequest(
  c: Context,
  env: BackendAppEnv,
  apiKey: string,
): Promise<WorkOSUserAuthContext | undefined> {
  const token = bearerToken(c);
  if (!token || token === apiKey) return undefined;
  return authenticateWorkOSAccessToken(env, token, {
    requireOrganization: false,
  });
}

export function authenticateWorkOSAccessToken(
  env: BackendAppEnv,
  token: string,
  options: { requireOrganization: false },
): Promise<WorkOSUserAuthContext>;
export function authenticateWorkOSAccessToken(
  env: BackendAppEnv,
  token: string,
): Promise<Extract<AuthContext, { kind: "workos" }>>;
export function authenticateWorkOSAccessToken(
  env: BackendAppEnv,
  token: string,
  options: { requireOrganization?: boolean } = {},
): Promise<WorkOSUserAuthContext> {
  return options.requireOrganization === false
    ? authenticateWorkOSToken(env, token, { requireOrganization: false })
    : authenticateWorkOSToken(env, token);
}

export function resolveAuthorizedTenant(
  _c: Context,
  auth: Extract<AuthContext, { kind: "workos" }>,
  requestedTenantId: string | undefined,
): string {
  const tenantId = requestedTenantId?.trim() || auth.tenantId;
  if (tenantId !== auth.tenantId) {
    throw new PlatformApiError(
      403,
      "forbidden",
      "Authenticated users can only access their selected WorkOS organization.",
    );
  }
  return tenantId;
}

export function isWorkOSConfigured(env: BackendAppEnv): boolean {
  return Boolean(resolveWorkOSClientId(env));
}

export function authClientConfig(env: BackendAppEnv): {
  provider: "workos";
  clientId: string;
  apiHostname: string;
  cliApiHostname: string;
} | null {
  const clientId = resolveWorkOSClientId(env);
  if (!clientId) return null;
  return {
    provider: "workos",
    clientId,
    apiHostname: workOSApiHostname(
      env.WORKOS_CLIENT_API_HOSTNAME ??
        env.VITE_WORKOS_API_HOSTNAME ??
        env.WORKOS_API_HOSTNAME,
    ),
    cliApiHostname: workOSApiHostname(env.WORKOS_API_HOSTNAME),
  };
}

function bearerToken(c: Context): string | undefined {
  const header = c.req.header("Authorization");
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

const workOSJwksCache = new Map<
  string,
  ReturnType<typeof createRemoteJWKSet>
>();

async function authenticateWorkOSToken(
  env: BackendAppEnv,
  token: string,
): Promise<Extract<AuthContext, { kind: "workos" }>>;
async function authenticateWorkOSToken(
  env: BackendAppEnv,
  token: string,
  options: { requireOrganization: false },
): Promise<WorkOSUserAuthContext>;
async function authenticateWorkOSToken(
  env: BackendAppEnv,
  token: string,
  options: { requireOrganization?: boolean } = {},
): Promise<WorkOSUserAuthContext> {
  const requireOrganization = options.requireOrganization ?? true;
  const config = resolveWorkOSAuthConfig(env);
  if (!config) {
    throw new PlatformApiError(
      401,
      "unauthorized",
      "WorkOS authentication is not configured.",
    );
  }

  let payload: WorkOSAccessTokenClaims;
  try {
    const verified = await jwtVerify(token, workOSJwks(config.jwksUrl), {
      ...(config.issuer ? { issuer: config.issuer } : {}),
    });
    payload = verified.payload as WorkOSAccessTokenClaims;
  } catch {
    throw new PlatformApiError(
      401,
      "unauthorized",
      "Invalid WorkOS access token.",
    );
  }

  const userId = payload.sub;
  const tenantId = payload.org_id;
  if (!userId) {
    throw new PlatformApiError(
      401,
      "unauthorized",
      "WorkOS access token is missing a subject.",
    );
  }
  if (!tenantId) {
    if (requireOrganization) {
      throw new PlatformApiError(
        403,
        "missing_organization",
        "Select a WorkOS organization before using tenant deployment APIs.",
      );
    }
  }

  return {
    kind: "workos",
    userId,
    ...(tenantId ? { tenantId } : {}),
    ...(typeof payload.role === "string" ? { role: payload.role } : {}),
    permissions: Array.isArray(payload.permissions)
      ? payload.permissions.filter(
          (permission): permission is string => typeof permission === "string",
        )
      : [],
  };
}

function resolveWorkOSAuthConfig(
  env: BackendAppEnv,
): WorkOSAuthConfig | undefined {
  const clientId = resolveWorkOSClientId(env);
  if (!clientId) return undefined;
  const apiOrigin = workOSApiOrigin(env.WORKOS_API_HOSTNAME);
  const issuer =
    env.WORKOS_ISSUER?.trim() ||
    `${apiOrigin}/user_management/${encodeURIComponent(clientId)}`;
  return {
    issuer: workOSIssuerCandidates(issuer),
    jwksUrl:
      env.WORKOS_JWKS_URL?.trim() ||
      `${apiOrigin}/sso/jwks/${encodeURIComponent(clientId)}`,
  };
}

function workOSJwks(jwksUrl: string): ReturnType<typeof createRemoteJWKSet> {
  const cached = workOSJwksCache.get(jwksUrl);
  if (cached) return cached;
  const jwks = createRemoteJWKSet(new URL(jwksUrl));
  workOSJwksCache.set(jwksUrl, jwks);
  return jwks;
}

function workOSApiOrigin(hostname: string | undefined): string {
  const value = hostname?.trim() || "api.workos.com";
  if (/^https?:\/\//i.test(value)) return value.replace(/\/+$/, "");
  return `https://${value.replace(/^\/+|\/+$/g, "")}`;
}

function workOSApiHostname(hostname: string | undefined): string {
  return new URL(workOSApiOrigin(hostname)).hostname;
}

function resolveWorkOSClientId(env: BackendAppEnv): string | undefined {
  return env.WORKOS_CLIENT_ID?.trim();
}

function workOSIssuerCandidates(issuer: string): string[] {
  const withoutSlash = issuer.replace(/\/+$/, "");
  return [withoutSlash, `${withoutSlash}/`];
}
