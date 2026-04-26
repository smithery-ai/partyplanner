import { slackAuthSchema } from "@workflow/integrations-slack";
import type { TokenIssuedValue } from "@workflow/oauth-broker";
import type { BackendAppEnv } from "../types";
import { isRecord } from "../utils";
import { createWebhookLogger } from "../webhooks/log";
import type {
  ParsedWebhook,
  WebhookPreflightResponse,
  WebhookProviderSpec,
  WebhookVerifyResult,
} from "../webhooks/provider";
import type { ProviderInstallationRegistry } from "../webhooks/registry";

const SLACK_PROVIDER_ID = "slack";
const SLACK_SIGNATURE_VERSION = "v0";
const SLACK_TIMESTAMP_TOLERANCE_MS = 5 * 60_000;
const textEncoder = new TextEncoder();

export function createSlackWebhookProvider(
  env: BackendAppEnv,
): WebhookProviderSpec {
  return {
    id: SLACK_PROVIDER_ID,
    async verify(request, rawBody): Promise<WebhookVerifyResult> {
      const signingSecret = env.SLACK_SIGNING_SECRET?.trim();
      if (!signingSecret) {
        return {
          ok: false,
          status: 503,
          error: "slack_signing_secret_missing",
          message:
            "SLACK_SIGNING_SECRET is required to receive Slack webhooks.",
        };
      }
      return verifySlackRequest(request, rawBody, signingSecret);
    },
    parse: parseSlackWebhook,
    preflight,
    registerOAuthInstallation,
  };
}

function preflight(
  parsed: ParsedWebhook,
): WebhookPreflightResponse | undefined {
  if (parsed.kind !== "url_verification") return undefined;
  const challenge = isRecord(parsed.payload)
    ? stringValue(parsed.payload.challenge)
    : undefined;
  // Per https://docs.slack.dev/reference/events/url_verification/, respond
  // with the raw challenge value as plain text. Slack also accepts JSON, but
  // plain text is the canonical, intermediary-safe response.
  return {
    status: 200,
    bodyText: challenge ?? "",
    contentType: "text/plain; charset=utf-8",
  };
}

async function registerOAuthInstallation(
  event: TokenIssuedValue,
  registry: ProviderInstallationRegistry,
): Promise<void> {
  if (event.providerId !== SLACK_PROVIDER_ID) return;

  const log = createWebhookLogger(SLACK_PROVIDER_ID);
  log.info("oauth_install_received", {
    runtimeHandoffUrl: event.pending.runtimeHandoffUrl,
  });

  const token = slackAuthSchema.safeParse(event.token);
  if (!token.success) {
    log.error("oauth_install_skipped_invalid_token", {
      issues: token.error.issues.map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
        message: issue.message,
      })),
    });
    return;
  }

  const identity = stripUndefined({
    teamId: token.data.teamId,
    enterpriseId: token.data.enterpriseId,
    appId: token.data.appId,
  });
  const installationKey = slackInstallationKey(identity);
  if (!installationKey) {
    log.error("oauth_install_skipped_missing_identity", {
      identity,
      reason:
        "Slack OAuth response had neither team_id nor enterprise_id; cannot derive an installation key.",
    });
    return;
  }

  // Best-effort: derive the deployment id from a /workers/<id>/... path
  // (production URL shape). In dev, runtimeHandoffUrl is per-worker
  // subdomain like https://<workflow>.localhost/..., where there's no path
  // segment to parse — that's fine, deploymentId is informational only and
  // webhook routing uses runtimeHandoffUrl directly.
  const deploymentId = deploymentIdFromRuntimeHandoffUrl(
    event.pending.runtimeHandoffUrl,
  );

  await registry.upsert({
    installationKey,
    providerId: SLACK_PROVIDER_ID,
    ...(deploymentId ? { deploymentId } : {}),
    identity,
    runtimeHandoffUrl: event.pending.runtimeHandoffUrl,
  });
  log.info("oauth_install_persisted", {
    installationKey,
    ...(deploymentId ? { deploymentId } : { deploymentId: null }),
    identity,
    runtimeHandoffUrl: event.pending.runtimeHandoffUrl,
  });
}

async function verifySlackRequest(
  request: Request,
  rawBody: string,
  signingSecret: string,
): Promise<WebhookVerifyResult> {
  const timestamp = request.headers.get("x-slack-request-timestamp");
  const signature = request.headers.get("x-slack-signature");
  if (!timestamp || !signature) {
    return {
      ok: false,
      status: 401,
      error: "missing_signature",
      diagnostics: {
        hasTimestamp: Boolean(timestamp),
        hasSignature: Boolean(signature),
      },
    };
  }

  const unixMs = Number(timestamp) * 1000;
  if (!Number.isFinite(unixMs)) {
    return {
      ok: false,
      status: 401,
      error: "invalid_timestamp",
      diagnostics: { rawTimestamp: timestamp },
    };
  }
  const skewMs = Date.now() - unixMs;
  if (Math.abs(skewMs) > SLACK_TIMESTAMP_TOLERANCE_MS) {
    return {
      ok: false,
      status: 401,
      error: "stale_timestamp",
      message: `Slack timestamp drift ${skewMs}ms exceeds tolerance ${SLACK_TIMESTAMP_TOLERANCE_MS}ms.`,
      diagnostics: { skewMs, toleranceMs: SLACK_TIMESTAMP_TOLERANCE_MS },
    };
  }

  if (!signature.startsWith(`${SLACK_SIGNATURE_VERSION}=`)) {
    return {
      ok: false,
      status: 401,
      error: "invalid_signature",
      message: `Signature header missing "${SLACK_SIGNATURE_VERSION}=" prefix.`,
      diagnostics: {
        signaturePrefix: signature.slice(0, 4),
        signatureLength: signature.length,
      },
    };
  }

  const expected = await hmacHex(
    signingSecret,
    `${SLACK_SIGNATURE_VERSION}:${timestamp}:${rawBody}`,
  );
  const expectedSignature = `${SLACK_SIGNATURE_VERSION}=${expected}`;
  if (timingSafeEqual(expectedSignature, signature)) {
    return { ok: true };
  }
  return {
    ok: false,
    status: 401,
    error: "invalid_signature",
    message:
      "HMAC mismatch. Common causes: SLACK_SIGNING_SECRET belongs to a different Slack app, has trailing whitespace/newline, or a proxy modified the request body.",
    diagnostics: {
      bodyLength: rawBody.length,
      bodySha256Prefix: (await sha256Hex(rawBody)).slice(0, 12),
      bodyHeadHex: hexPrefix(rawBody, 16),
      bodyTailHex: hexSuffix(rawBody, 16),
      signingSecretLength: signingSecret.length,
      signingSecretSha256Prefix: (await sha256Hex(signingSecret)).slice(0, 12),
      timestampHeader: timestamp,
      timestampSkewMs: skewMs,
      hostHeader: request.headers.get("host"),
      contentEncoding: request.headers.get("content-encoding"),
      contentLengthHeader: request.headers.get("content-length"),
      signaturePrefix: signature.slice(0, 8),
      expectedSignaturePrefix: expectedSignature.slice(0, 8),
    },
  };
}

function hexPrefix(value: string, byteCount: number): string {
  const bytes = textEncoder.encode(value).slice(0, byteCount);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexSuffix(value: string, byteCount: number): string {
  const encoded = textEncoder.encode(value);
  const bytes = encoded.slice(Math.max(0, encoded.length - byteCount));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    textEncoder.encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    textEncoder.encode(value),
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let i = 0; i < left.length; i += 1) {
    mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return mismatch === 0;
}

function parseSlackWebhook(
  contentType: string | undefined,
  rawBody: string,
): ParsedWebhook {
  const normalized = contentType?.split(";")[0]?.trim().toLowerCase();
  if (normalized === "application/json") {
    const payload = parseJsonRecord(rawBody);
    const type = stringValue(payload.type);
    if (type === "url_verification") {
      const challenge = stringValue(payload.challenge);
      if (!challenge) {
        throw new Error("Slack URL verification is missing challenge.");
      }
      return parsedFromJsonEvent("url_verification", payload);
    }
    return parsedFromJsonEvent("event_callback", payload);
  }

  if (normalized === "application/x-www-form-urlencoded") {
    const form = Object.fromEntries(new URLSearchParams(rawBody).entries());
    const interactive = form.payload?.trim();
    if (interactive) {
      const payload = parseJsonRecord(interactive);
      return {
        kind: "interactive",
        identity: identityFromInteractive(payload),
        runContextHints: collectInteractiveRunContextHints(payload),
        payload,
      };
    }
    return {
      kind: "slash_command",
      identity: stripIdentity({
        anyOf: {
          teamId: stringValue(form.team_id),
          enterpriseId: stringValue(form.enterprise_id),
        },
        allOf: { appId: stringValue(form.api_app_id) },
      }),
      runContextHints: [],
      payload: form,
    };
  }

  throw new Error(
    `Unsupported Slack content type: ${contentType ?? "unknown"}`,
  );
}

function parsedFromJsonEvent(
  kind: "url_verification" | "event_callback",
  payload: Record<string, unknown>,
): ParsedWebhook {
  const eventId = stringValue(payload.event_id);
  const eventTime =
    typeof payload.event_time === "number" ? payload.event_time : undefined;
  return {
    kind,
    identity: stripIdentity({
      anyOf: {
        teamId: stringValue(payload.team_id),
        enterpriseId: stringValue(payload.enterprise_id),
      },
      allOf: { appId: stringValue(payload.api_app_id) },
    }),
    runContextHints: [],
    metadata: {
      ...(eventId ? { eventId } : {}),
      ...(eventTime ? { eventTime } : {}),
    },
    payload,
  };
}

function identityFromInteractive(payload: Record<string, unknown>): {
  anyOf: Record<string, string>;
  allOf?: Record<string, string>;
} {
  return stripIdentity({
    anyOf: {
      teamId: stringValue(nestedValue(payload, ["team", "id"])),
      enterpriseId: stringValue(nestedValue(payload, ["enterprise", "id"])),
    },
    allOf: { appId: stringValue(payload.api_app_id) },
  });
}

function collectInteractiveRunContextHints(
  payload: Record<string, unknown>,
): string[] {
  const hints: string[] = [];
  pushIfPresent(hints, stringValue(payload.private_metadata));
  pushIfPresent(
    hints,
    stringValue(nestedValue(payload, ["view", "private_metadata"])),
  );
  pushIfPresent(
    hints,
    stringValue(
      nestedValue(payload, ["message", "metadata", "event_payload", "runId"]),
    ),
  );
  if (Array.isArray(payload.actions)) {
    for (const action of payload.actions) {
      if (isRecord(action)) pushIfPresent(hints, stringValue(action.value));
    }
  }
  return hints;
}

function pushIfPresent(values: string[], candidate: string | undefined): void {
  if (candidate) values.push(candidate);
}

function stripIdentity(identity: {
  anyOf: Record<string, string | undefined>;
  allOf?: Record<string, string | undefined>;
}): { anyOf: Record<string, string>; allOf?: Record<string, string> } {
  const anyOf = stripUndefined(identity.anyOf);
  const allOf = identity.allOf ? stripUndefined(identity.allOf) : {};
  return Object.keys(allOf).length > 0 ? { anyOf, allOf } : { anyOf };
}

function stripUndefined(
  value: Record<string, string | undefined>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(value)) {
    if (typeof val === "string" && val) result[key] = val;
  }
  return result;
}

function parseJsonRecord(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value);
  if (!isRecord(parsed)) throw new Error("Expected a JSON object payload.");
  return parsed;
}

function nestedValue(value: unknown, path: string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function deploymentIdFromRuntimeHandoffUrl(
  runtimeHandoffUrl: string,
): string | undefined {
  try {
    const pathname = new URL(runtimeHandoffUrl).pathname;
    const match = pathname.match(/^\/workers\/([^/]+)(?:\/|$)/);
    return match ? decodeURIComponent(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

function slackInstallationKey(identity: {
  teamId?: string;
  enterpriseId?: string;
  appId?: string;
}): string | undefined {
  if (!identity.teamId && !identity.enterpriseId) return undefined;
  const scope = identity.enterpriseId
    ? `enterprise:${identity.enterpriseId}`
    : `team:${identity.teamId}`;
  return identity.appId ? `${scope}:app:${identity.appId}` : scope;
}
