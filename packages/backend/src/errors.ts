import type { Context } from "hono";

export type PlatformErrorStatus = 400 | 401 | 403 | 404 | 500 | 502 | 503;

export class PlatformApiError extends Error {
  constructor(
    readonly status: PlatformErrorStatus,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function apiErrorResponse(c: Context, e: unknown): Response {
  if (e instanceof PlatformApiError) {
    return c.json(
      {
        error: e.code,
        message: e.message,
        ...(e.details === undefined ? {} : { details: e.details }),
      },
      e.status,
    );
  }

  console.error("[hylo-backend] unhandled API error", e);
  return c.json(
    {
      error: "internal_error",
      message: e instanceof Error ? e.message : "Unexpected error.",
    },
    500,
  );
}
