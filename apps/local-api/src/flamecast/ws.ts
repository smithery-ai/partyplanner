import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer } from "ws";
import type { StreamManager } from "./stream-manager.js";

const EVENT_STREAM_PATH = "/api/stream";

export interface WebSocketServerOptions {
  validateToken?: (token: string) => boolean;
}

export function attachWebSocketServer(
  httpServer: Server,
  streamManager: StreamManager,
  options?: WebSocketServerOptions,
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (request: IncomingMessage, socket, head) => {
    const url = new URL(request.url ?? "", `http://${request.headers.host}`);

    if (url.pathname !== EVENT_STREAM_PATH) {
      socket.destroy();
      return;
    }

    if (options?.validateToken) {
      const token = url.searchParams.get("token");
      if (!token || !options.validateToken(token)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
      streamManager.addClient(ws);
    });
  });

  return wss;
}
