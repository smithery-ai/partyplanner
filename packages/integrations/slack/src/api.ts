import { z } from "zod";

const slackErrorSchema = z
  .object({
    ok: z.literal(false),
    error: z.string(),
  })
  .passthrough();

export async function parseSlackApiResponse<T>(
  response: Response,
  schema: z.ZodType<T>,
  label: string,
): Promise<T> {
  const raw = await response.json();
  if (!response.ok) {
    throw new Error(
      `Slack ${label} failed (${response.status}): ${JSON.stringify(raw)}`,
    );
  }

  const apiError = slackErrorSchema.safeParse(raw);
  if (apiError.success) {
    throw new Error(`Slack ${label} failed: ${apiError.data.error}`);
  }

  return schema.parse(raw);
}
