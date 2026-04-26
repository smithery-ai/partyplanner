import type { TokenIssuedValue } from "@workflow/oauth-broker";
import type { ProviderInstallationRegistry } from "./registry";

export type WebhookVerifyResult =
  | { ok: true }
  | {
      ok: false;
      status: number;
      error: string;
      message?: string;
      // Safe-to-log diagnostic context (no secrets, no full payloads).
      diagnostics?: Record<string, unknown>;
    };

export type ParsedWebhook = {
  kind: string;
  // Identity claims used to look up the matching provider installation.
  identity: {
    anyOf: Record<string, string>;
    allOf?: Record<string, string>;
  };
  // Strings that may carry workflow run context (runId/deploymentId).
  // Each candidate is tried in order until one resolves.
  runContextHints: string[];
  // Extra fields flattened into the worker-bound payload (e.g. eventId).
  metadata?: Record<string, unknown>;
  payload: unknown;
};

export type WebhookPreflightResponse =
  | { status: number; bodyJson: Record<string, unknown> }
  | { status: number; bodyText: string; contentType?: string };

export type WebhookProviderSpec = {
  id: string;
  verify(request: Request, rawBody: string): Promise<WebhookVerifyResult>;
  parse(contentType: string | undefined, rawBody: string): ParsedWebhook;
  preflight?(parsed: ParsedWebhook): WebhookPreflightResponse | undefined;
  registerOAuthInstallation?(
    event: TokenIssuedValue,
    registry: ProviderInstallationRegistry,
  ): Promise<void>;
};
