import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { swaggerUI } from "@hono/swagger-ui";
import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { createMcpHandler } from "./mcp.js";
import { claudeSessionRoutes } from "./routes/claude-sessions.js";
import { fileRoutes } from "./routes/files.js";
import { sessionRoutes } from "./routes/sessions.js";
import { SessionLogger } from "./session-logger.js";
import { SessionManager } from "./sessions/session-manager.js";
import { StreamManager } from "./stream-manager.js";
import { attachWebSocketServer, type WebSocketServerOptions } from "./ws.js";

const pkgPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../package.json",
);
const pkg: { version: string } = JSON.parse(readFileSync(pkgPath, "utf-8"));

function createApp(sessions: SessionManager, logger: SessionLogger) {
  const app = new OpenAPIHono();
  app.onError((err, c) => {
    return c.json({ error: err.message }, 500);
  });
  app.use(
    "*",
    cors({
      origin: (origin) => origin || "*",
      allowHeaders: [
        "Content-Type",
        "Authorization",
        "Mcp-Session-Id",
        "MCP-Protocol-Version",
      ],
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      exposeHeaders: ["Mcp-Session-Id"],
    }),
  );

  // MCP streamable HTTP endpoint
  const handleMcp = createMcpHandler(sessions);
  app.all("/mcp", (c) => handleMcp(c));

  const routes = app
    .get("/", (c) => c.json({ name: "flamecast", status: "ok" }))
    .route("/api", sessionRoutes(sessions, logger))
    .route("/api", claudeSessionRoutes(logger))
    .route("/api", fileRoutes());

  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: { title: "Flamecast", version: pkg.version },
  });
  app.get("/api/ui", swaggerUI({ url: "/openapi.json" }));

  return routes;
}

export type AppType = ReturnType<typeof createApp>;
export type { WebSocketServerOptions } from "./ws.js";

export class Flamecast {
  readonly app: AppType;
  readonly sessions: SessionManager;
  readonly streams: StreamManager;
  readonly logger: SessionLogger;

  constructor() {
    this.logger = new SessionLogger();
    this.sessions = new SessionManager();
    this.sessions.setLogger(this.logger);
    this.streams = new StreamManager(this.logger);
    this.app = createApp(this.sessions, this.logger);
  }

  attachWebSockets(httpServer: Server, options?: WebSocketServerOptions): void {
    attachWebSocketServer(httpServer, this.streams, options);
  }
}
