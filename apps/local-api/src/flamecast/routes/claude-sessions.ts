import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { SessionLogger } from "../session-logger.js";

const ClaudeSessionIdParam = z.object({
  id: z.string().openapi({
    param: { name: "id", in: "path" },
    example: "cd62d8f2-05c2-4051-ab80-1288751c9af7",
  }),
});

const ListResponse = z
  .object({
    sessions: z.array(z.string()),
  })
  .openapi("ListClaudeSessionsResponse");

const GetResponse = z
  .object({
    sessionId: z.string(),
    events: z.array(z.unknown()),
  })
  .openapi("GetClaudeSessionResponse");

const ErrorResponse = z
  .object({
    error: z.string(),
  })
  .openapi("ErrorResponse");

const listClaudeSessions = createRoute({
  method: "get",
  path: "/claude-sessions",
  tags: ["ClaudeSessions"],
  summary: "List Claude session IDs that have been logged",
  responses: {
    200: {
      content: { "application/json": { schema: ListResponse } },
      description: "Logged Claude session IDs",
    },
  },
});

const getClaudeSession = createRoute({
  method: "get",
  path: "/claude-sessions/{id}",
  tags: ["ClaudeSessions"],
  summary: "Get logged events for a Claude session",
  request: { params: ClaudeSessionIdParam },
  responses: {
    200: {
      content: { "application/json": { schema: GetResponse } },
      description: "Parsed NDJSON events",
    },
    404: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Session log not found",
    },
  },
});

export function claudeSessionRoutes(logger: SessionLogger) {
  const app = new OpenAPIHono();
  return app
    .openapi(listClaudeSessions, async (c) => {
      const sessions = await logger.listClaudeSessions();
      return c.json({ sessions }, 200);
    })
    .openapi(getClaudeSession, async (c) => {
      const { id } = c.req.valid("param");
      const content = await logger.readClaudeSession(id);
      if (content == null) {
        return c.json({ error: "Not found" }, 404);
      }
      const events: unknown[] = [];
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          events.push(JSON.parse(trimmed));
        } catch {
          // skip
        }
      }
      return c.json({ sessionId: id, events }, 200);
    });
}
