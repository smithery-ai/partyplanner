import { describe, expect, it } from "vitest";
import { notionApiError } from "../src/errors";

describe("notionApiError", () => {
  it("adds an access hint for Notion object-not-found responses", async () => {
    const error = await notionApiError(
      new Response(
        JSON.stringify({
          object: "error",
          status: 404,
          code: "object_not_found",
          message: "Could not find page with ID: page-id.",
        }),
        { status: 404 },
      ),
      "GET /v1/pages/page-id",
    );

    expect(error.message).toContain("GET /v1/pages/page-id failed (404)");
    expect(error.message).toContain(
      "Share the relevant Notion page or database",
    );
    expect(error.message).toContain("reconnect Notion");
  });
});
