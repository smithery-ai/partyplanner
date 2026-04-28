import type { WebSocket } from "ws";
import type { SessionLogger } from "./session-logger.js";
import * as tmux from "./sessions/tmux.js";
import { serializeTerminalSnapshot } from "./terminal-snapshot.js";

interface StreamState {
  sessionId: string;
  clients: Set<WebSocket>;
  pendingOutput: string;
}

function formatPaneSnapshot(snapshot: tmux.PaneSnapshot): string {
  return serializeTerminalSnapshot(
    snapshot.output,
    snapshot.cursorX,
    snapshot.cursorY,
  );
}

export class StreamManager {
  private readonly streams = new Map<string, StreamState>();
  private readonly chatLogClients = new Set<WebSocket>();

  constructor(private readonly logger: SessionLogger) {
    this.logger.on("chunk", (sessionId, chunk) => {
      this.fanout(sessionId, chunk);
    });
    this.logger.on("chatEvent", (event) => {
      this.fanoutChatLog({
        type: "chat_event",
        ...event,
      });
    });
  }

  async addClient(sessionId: string, ws: WebSocket): Promise<void> {
    let state = this.streams.get(sessionId);

    if (!state) {
      state = {
        sessionId,
        clients: new Set(),
        pendingOutput: "",
      };
      this.streams.set(sessionId, state);
    }

    state.clients.add(ws);

    // Replay the current pane so a newly attached client sees the existing prompt/output.
    try {
      const output = formatPaneSnapshot(
        await tmux.captureTerminalSnapshot(sessionId),
      );
      if (output && ws.readyState === ws.OPEN) {
        ws.send(output);
      }
    } catch {
      // session may not be ready yet
    }

    ws.on("close", () => this.removeClient(sessionId, ws));
    ws.on("error", () => this.removeClient(sessionId, ws));
  }

  async handleMessage(sessionId: string, data: Buffer | string): Promise<void> {
    const msg = typeof data === "string" ? data : data.toString("utf-8");

    try {
      const parsed = JSON.parse(msg);
      if (
        parsed.type === "resize" &&
        typeof parsed.cols === "number" &&
        typeof parsed.rows === "number"
      ) {
        await tmux.resizeWindow(sessionId, parsed.cols, parsed.rows);
        return;
      }
    } catch {
      // Not JSON — treat as raw keystrokes
    }

    await tmux.sendKeys(sessionId, msg, true);
  }

  addChatLogClient(ws: WebSocket): void {
    this.chatLogClients.add(ws);
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "ready" }));
    }
    ws.on("close", () => this.chatLogClients.delete(ws));
    ws.on("error", () => this.chatLogClients.delete(ws));
  }

  disconnectAll(sessionId: string): void {
    const state = this.streams.get(sessionId);
    if (!state) return;
    for (const client of state.clients) {
      try {
        client.close(1001, "session closed");
      } catch {
        // ignore
      }
    }
    state.clients.clear();
    this.streams.delete(sessionId);
  }

  private fanout(sessionId: string, chunk: string): void {
    const state = this.streams.get(sessionId);
    if (!state || state.clients.size === 0) return;
    const output = this.stripUnsupportedSequences(state, chunk);
    if (!output) return;
    for (const client of state.clients) {
      if (client.readyState === client.OPEN) {
        client.send(output);
      }
    }
  }

  private fanoutChatLog(payload: unknown): void {
    if (this.chatLogClients.size === 0) return;
    const message = JSON.stringify(payload);
    for (const client of this.chatLogClients) {
      if (client.readyState === client.OPEN) {
        client.send(message);
      }
    }
  }

  private removeClient(sessionId: string, ws: WebSocket): void {
    const state = this.streams.get(sessionId);
    if (!state) return;
    state.clients.delete(ws);
    if (state.clients.size === 0) {
      state.pendingOutput = "";
      this.streams.delete(sessionId);
    }
  }

  private stripUnsupportedSequences(state: StreamState, chunk: string): string {
    const input = state.pendingOutput + chunk;
    let output = "";
    let start = 0;

    while (start < input.length) {
      const sequenceStart = input.indexOf("\x1bk", start);
      if (sequenceStart === -1) {
        output += input.slice(start);
        state.pendingOutput = "";
        return output;
      }

      output += input.slice(start, sequenceStart);
      const sequenceEnd = input.indexOf("\x1b\\", sequenceStart + 2);
      if (sequenceEnd === -1) {
        state.pendingOutput = input.slice(sequenceStart);
        return output;
      }

      start = sequenceEnd + 2;
    }

    state.pendingOutput = "";
    return output;
  }
}
