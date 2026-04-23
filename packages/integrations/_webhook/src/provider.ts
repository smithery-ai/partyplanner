// Describes how to verify and parse inbound webhooks from a single provider.
// Each integration package (e.g. `@workflow/integrations-slack`) exports one of
// these alongside its OAuth spec and helper atoms/actions.
//
// The broker reads `verifyRequest` and `parseEvent` to authenticate incoming
// webhook POSTs and normalize them into workflow inputs.
export type WebhookProviderSpec = {
  // Unique provider id. Must match the OAuth provider id when both exist.
  // Convention: lowercase, no slashes, e.g. "slack", "github".
  id: string;

  // Verify the incoming request is authentic (e.g. Slack HMAC-SHA256).
  // `rawBody` is the un-parsed request body text so the provider can compute
  // signatures without re-reading the stream.
  verifyRequest(
    req: Request,
    rawBody: string,
    secret: string,
  ): Promise<boolean>;

  // Handle provider-specific setup handshakes (e.g. Slack url_verification
  // challenge). Return a Response to short-circuit, or null to continue
  // normal webhook processing.
  handleSetup?(body: unknown): Response | null;

  // Extract a normalized event from the parsed webhook payload.
  parseEvent(body: unknown): { eventType: string; payload: unknown };
};
