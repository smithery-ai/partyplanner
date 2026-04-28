export { FlamecastClient } from "./flamecast/client.js";
export type { AppType, WebSocketServerOptions } from "./flamecast/index.js";
export { Flamecast } from "./flamecast/index.js";
export { createMcpHandler, createMcpServer } from "./flamecast/mcp.js";
export {
  SessionError,
  SessionManager,
} from "./flamecast/sessions/session-manager.js";
export type {
  CloseParams,
  CloseResult,
  CreateParams,
  CreateResult,
  ExecAsyncParams,
  ExecAsyncResult,
  ExecParams,
  ExecResult,
  GetParams,
  GetResult,
  InputParams,
  InputResult,
  ListResult,
  Session,
  SessionStatus,
} from "./flamecast/sessions/types.js";
export { StreamManager } from "./flamecast/stream-manager.js";
