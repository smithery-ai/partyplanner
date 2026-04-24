import { z } from "@hono/zod-openapi";

export const JsonContentType = "application/json";
export const BearerSecurity = [{ bearerAuth: [] }];

export const PlatformErrorResponseSchema = z
  .object({
    error: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  })
  .openapi("PlatformErrorResponse");

export function openApiJsonResponse(description: string, schema: z.ZodType) {
  return {
    description,
    content: {
      [JsonContentType]: { schema },
    },
  };
}

export function typedRouteResponse(response: Response): never {
  return response as never;
}
