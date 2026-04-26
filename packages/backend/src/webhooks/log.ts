type LogLevel = "info" | "warn" | "error";

export type WebhookLogger = {
  requestId: string;
  providerId: string;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
};

export function createWebhookLogger(providerId: string): WebhookLogger {
  const requestId = randomRequestId();
  const emit = (
    level: LogLevel,
    event: string,
    fields?: Record<string, unknown>,
  ) => {
    const line = JSON.stringify({
      scope: "webhook",
      level,
      providerId,
      requestId,
      event,
      ...(fields ?? {}),
    });
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.info(line);
  };
  return {
    requestId,
    providerId,
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
  };
}

function randomRequestId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID().slice(0, 8);
  }
  return Math.random().toString(36).slice(2, 10);
}
