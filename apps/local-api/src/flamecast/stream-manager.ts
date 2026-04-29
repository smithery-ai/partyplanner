import type { WebSocket } from "ws";
import type { SessionLogger } from "./session-logger.js";

export class StreamManager {
  private readonly clients = new Set<WebSocket>();

  constructor(private readonly logger: SessionLogger) {
    this.logger.on("chatEvent", (event) => {
      this.broadcast({
        type: "chat_event",
        ...event,
      });
    });
  }

  addClient(ws: WebSocket): void {
    this.clients.add(ws);
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "ready" }));
    }
    ws.on("close", () => this.clients.delete(ws));
    ws.on("error", () => this.clients.delete(ws));
  }

  private broadcast(payload: unknown): void {
    if (this.clients.size === 0) return;
    const message = JSON.stringify(payload);
    for (const client of this.clients) {
      if (client.readyState === client.OPEN) {
        client.send(message);
      }
    }
  }
}
