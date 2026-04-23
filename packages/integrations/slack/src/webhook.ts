import type { WebhookProviderSpec } from "@workflow/integrations-webhook";

export const slackWebhookProvider: WebhookProviderSpec = {
  id: "slack",

  async verifyRequest(
    req: Request,
    rawBody: string,
    secret: string,
  ): Promise<boolean> {
    const timestamp = req.headers.get("x-slack-request-timestamp");
    const signature = req.headers.get("x-slack-signature");
    if (!timestamp || !signature) return false;

    // Reject requests older than 5 minutes to prevent replay attacks.
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - parseInt(timestamp, 10)) > 300) return false;

    const baseString = `v0:${timestamp}:${rawBody}`;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(baseString),
    );
    const hex = Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const expected = `v0=${hex}`;

    // Constant-time comparison to prevent timing attacks.
    if (signature.length !== expected.length) return false;
    let mismatch = 0;
    for (let i = 0; i < signature.length; i++) {
      mismatch |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
    }
    return mismatch === 0;
  },

  handleSetup(body: unknown): Response | null {
    if (
      typeof body === "object" &&
      body !== null &&
      "type" in body &&
      (body as Record<string, unknown>).type === "url_verification"
    ) {
      const challenge = (body as Record<string, unknown>).challenge;
      return new Response(JSON.stringify({ challenge }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return null;
  },

  parseEvent(body: unknown): { eventType: string; payload: unknown } {
    const outer = body as Record<string, unknown>;
    const event = outer.event as Record<string, unknown> | undefined;
    return {
      eventType: typeof event?.type === "string" ? event.type : "unknown",
      payload: event ?? outer,
    };
  },
};
