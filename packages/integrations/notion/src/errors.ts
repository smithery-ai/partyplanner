export async function notionApiError(
  response: Response,
  operation: string,
): Promise<Error> {
  const body = await response.text();
  const detail = notionErrorDetail(body);
  const hint =
    response.status === 404 && detail?.code === "object_not_found"
      ? " Share the relevant Notion page or database with the authorized integration, or reconnect Notion and select that page during authorization."
      : "";

  return new Error(
    `Notion ${operation} failed (${response.status}): ${body}${hint}`,
  );
}

function notionErrorDetail(
  body: string,
): { code?: string; message?: string } | undefined {
  try {
    const parsed = JSON.parse(body) as { code?: unknown; message?: unknown };
    return {
      code: typeof parsed.code === "string" ? parsed.code : undefined,
      message: typeof parsed.message === "string" ? parsed.message : undefined,
    };
  } catch {
    return undefined;
  }
}
