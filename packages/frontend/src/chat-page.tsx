import { code as codePlugin } from "@streamdown/code";
import { math as mathPlugin } from "@streamdown/math";
import { mermaid as mermaidPlugin } from "@streamdown/mermaid";
import {
  Brain,
  Bug,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  MessageSquare,
  Plus,
  RefreshCw,
  User,
  Wrench,
} from "lucide-react";
import {
  createContext,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Streamdown } from "streamdown";
import { Button } from "./components/ui/button";
import { DotmSquare1 } from "./components/ui/dotm-square-1";

const STREAMDOWN_PLUGINS = {
  code: codePlugin,
  math: mathPlugin,
  mermaid: mermaidPlugin,
} as const;

const DEFAULT_LOCAL_API_BASE = "https://local-api.localhost";

const DebugContext = createContext(false);

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI_RE = new RegExp(
  `${ESC}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|k[^${ESC}]*${ESC}\\\\|[PX^_].*?${ESC}\\\\|[=>]|\\([AB012])`,
  "g",
);

function stripAnsi(input: string): string {
  return input.replace(ANSI_RE, "");
}

function cls(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

type ChatStatus = "running" | "closed";

interface ChatSummary {
  chatId: string;
  status: ChatStatus;
  activeTerminalSessionId: string | null;
  claudeSessionIds: string[];
  terminalSessionIds: string[];
  created: string;
  lastActivity: string;
}

const STATUS_DOT: Record<ChatStatus, string> = {
  running: "bg-emerald-500",
  closed: "bg-muted-foreground",
};

function shortId(id: string): string {
  if (id.startsWith("chat_")) return id.slice(5, 13);
  return id.startsWith("fc_") ? id.slice(3) : id;
}

type Block =
  | {
      kind: "system";
      model: string;
      sessionId: string;
      cwd: string;
      raw: unknown;
    }
  | { kind: "thinking"; text: string; raw: unknown }
  | { kind: "text"; text: string; raw: unknown }
  | { kind: "user_text"; text: string; raw: unknown }
  | { kind: "tool_use"; name: string; input: unknown; raw: unknown }
  | { kind: "tool_result"; content: string; isError: boolean; raw: unknown }
  | {
      kind: "result";
      result: string;
      durationMs: number;
      cost: number;
      isError: boolean;
      stopReason: string;
      raw: unknown;
    };

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const obj = part as Record<string, unknown>;
          if (typeof obj.text === "string") return obj.text;
          if (typeof obj.tool_name === "string")
            return `tool: ${obj.tool_name}`;
        }
        return JSON.stringify(part);
      })
      .join("\n");
  }
  return JSON.stringify(content);
}

function eventUuid(obj: unknown): string | null {
  if (!obj || typeof obj !== "object") return null;
  const u = (obj as Record<string, unknown>).uuid;
  return typeof u === "string" ? u : null;
}

function eventDedupKey(obj: unknown): string | null {
  const uuid = eventUuid(obj);
  if (uuid) return `uuid:${uuid}`;
  if (!obj || typeof obj !== "object") return null;
  try {
    return `json:${JSON.stringify(obj)}`;
  } catch {
    return null;
  }
}

function statusFromEvent(obj: unknown): "running" | "open" | null {
  if (!obj || typeof obj !== "object") return null;
  const ev = obj as Record<string, unknown>;
  if (ev.type === "system" && ev.subtype === "init") return "running";
  if (ev.type === "result") return "open";
  return null;
}

function eventToBlocks(obj: unknown): Block[] {
  if (!obj || typeof obj !== "object") return [];
  const ev = obj as Record<string, unknown>;
  if (ev.type === "system" && ev.subtype === "init") {
    return [
      {
        kind: "system",
        model: String(ev.model ?? ""),
        sessionId: String(ev.session_id ?? ""),
        cwd: String(ev.cwd ?? ""),
        raw: obj,
      },
    ];
  }
  const message = (ev as { message?: { content?: unknown } }).message;
  const content = message?.content;
  if (ev.type === "assistant" && Array.isArray(content)) {
    return (content as unknown[]).flatMap((rawC) => {
      const c = rawC as Record<string, unknown>;
      if (c?.type === "thinking" && typeof c.thinking === "string") {
        return [{ kind: "thinking", text: c.thinking, raw: obj }] as Block[];
      }
      if (c?.type === "text" && typeof c.text === "string") {
        return [{ kind: "text", text: c.text, raw: obj }] as Block[];
      }
      if (c?.type === "tool_use") {
        return [
          {
            kind: "tool_use",
            name: String(c.name ?? ""),
            input: c.input,
            raw: obj,
          },
        ] as Block[];
      }
      return [] as Block[];
    });
  }
  if (ev.type === "user" && Array.isArray(content)) {
    return (content as unknown[]).flatMap((rawC) => {
      const c = rawC as Record<string, unknown>;
      if (c?.type === "text" && typeof c.text === "string") {
        return [{ kind: "user_text", text: c.text, raw: obj }] as Block[];
      }
      if (c?.type === "tool_result") {
        return [
          {
            kind: "tool_result",
            content: toolResultText(c.content),
            isError: Boolean(c.is_error),
            raw: obj,
          },
        ] as Block[];
      }
      return [] as Block[];
    });
  }
  if (ev.type === "result") {
    return [
      {
        kind: "result",
        result: String(ev.result ?? ""),
        durationMs: Number(ev.duration_ms ?? 0),
        cost: Number(ev.total_cost_usd ?? 0),
        isError: Boolean(ev.is_error),
        stopReason: String(ev.stop_reason ?? ""),
        raw: obj,
      },
    ];
  }
  return [];
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffSec = Math.round((Date.now() - then) / 1000);
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const min = Math.round(diffSec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  return `${seconds >= 10 ? Math.round(seconds) : seconds.toFixed(1)}s`;
}

export type ChatPageProps = {
  localApiBase?: string;
  onSelectedSessionIdChange?: (
    sessionId: string | null,
    options?: { replace?: boolean },
  ) => void;
  selectedSessionId?: string | null;
  sidebarFooter?: ReactNode;
};

export function ChatPage({
  localApiBase = DEFAULT_LOCAL_API_BASE,
  onSelectedSessionIdChange,
  selectedSessionId,
  sidebarFooter,
}: ChatPageProps) {
  return (
    <ChatShell
      localApiBase={localApiBase}
      onSelectedSessionIdChange={onSelectedSessionIdChange}
      selectedSessionId={selectedSessionId}
      sidebarFooter={sidebarFooter}
    />
  );
}

interface PanelState {
  blocks: Block[];
  status: PanelStatus;
  error: string | null;
}

const INITIAL_PANEL_STATE: PanelState = {
  blocks: [],
  status: "connecting",
  error: null,
};

function ChatShell({
  localApiBase,
  onSelectedSessionIdChange,
  selectedSessionId,
  sidebarFooter,
}: {
  localApiBase: string;
  onSelectedSessionIdChange?: (
    sessionId: string | null,
    options?: { replace?: boolean },
  ) => void;
  selectedSessionId?: string | null;
  sidebarFooter?: ReactNode;
}) {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [uncontrolledSelectedId, setUncontrolledSelectedId] = useState<
    string | null
  >(null);
  const [listError, setListError] = useState<string | null>(null);
  const [debug, setDebug] = useState(false);
  const [panelStates, setPanelStates] = useState<Map<string, PanelState>>(
    () => new Map(),
  );
  const [drafts, setDrafts] = useState<Map<string, string>>(() => new Map());
  const wsMapRef = useRef<Map<string, WebSocket>>(new Map());
  const wsTerminalIdsRef = useRef<Map<string, string>>(new Map());
  const activeTerminalIdsRef = useRef<Map<string, string>>(new Map());
  const lineBuffersRef = useRef<Map<string, string>>(new Map());
  const seenUuidsRef = useRef<Map<string, Set<string>>>(new Map());
  const selectedId =
    selectedSessionId === undefined
      ? uncontrolledSelectedId
      : selectedSessionId;

  const setSelectedId = useCallback(
    (sessionId: string | null, options?: { replace?: boolean }) => {
      if (selectedSessionId === undefined) {
        setUncontrolledSelectedId(sessionId);
      }
      onSelectedSessionIdChange?.(sessionId, options);
    },
    [onSelectedSessionIdChange, selectedSessionId],
  );

  const updatePanel = useCallback(
    (sessionId: string, updater: (s: PanelState) => PanelState) => {
      setPanelStates((prev) => {
        const cur = prev.get(sessionId) ?? INITIAL_PANEL_STATE;
        const next = new Map(prev);
        next.set(sessionId, updater(cur));
        return next;
      });
    },
    [],
  );

  // Fetches /events and appends only events whose uuid we haven't seen yet.
  // Safe to call repeatedly: as initial hydrate, as gap-fill on WS open,
  // periodic catch-up, and on resume after close.
  const hydrateSession = useCallback(
    async (chatId: string) => {
      let seen = seenUuidsRef.current.get(chatId);
      if (!seen) {
        seen = new Set<string>();
        seenUuidsRef.current.set(chatId, seen);
      }
      try {
        const res = await fetch(`${localApiBase}/api/chats/${chatId}/events`);
        if (!res.ok) return;
        const body = (await res.json()) as { events?: unknown[] };
        const newBlocks: Block[] = [];
        let nextStatus: "running" | "open" | null = null;
        for (const ev of body.events ?? []) {
          const key = eventDedupKey(ev);
          if (key && seen.has(key)) continue;
          if (key) seen.add(key);
          const transition = statusFromEvent(ev);
          if (transition) nextStatus = transition;
          newBlocks.push(...eventToBlocks(ev));
        }
        if (newBlocks.length > 0 || nextStatus) {
          updatePanel(chatId, (s) => ({
            ...s,
            blocks:
              newBlocks.length > 0 ? [...s.blocks, ...newBlocks] : s.blocks,
            status: nextStatus && s.status !== "error" ? nextStatus : s.status,
          }));
        }
      } catch {
        // best-effort
      }
    },
    [localApiBase, updatePanel],
  );

  const ensureConnection = useCallback(
    async (chatId: string) => {
      // Always make sure per-chat state containers exist so hydrate can
      // record uuids and append blocks even on re-selection.
      setPanelStates((prev) => {
        if (prev.has(chatId)) return prev;
        const next = new Map(prev);
        next.set(chatId, INITIAL_PANEL_STATE);
        return next;
      });
      if (!lineBuffersRef.current.has(chatId)) {
        lineBuffersRef.current.set(chatId, "");
      }
      if (!seenUuidsRef.current.has(chatId)) {
        seenUuidsRef.current.set(chatId, new Set<string>());
      }

      // Always hydrate on (re)entry so the user sees the latest persisted
      // log. dedup via the seen-event set keeps this idempotent.
      await hydrateSession(chatId);

      const terminalSessionId = activeTerminalIdsRef.current.get(chatId);
      if (!terminalSessionId) {
        updatePanel(chatId, (s) =>
          s.status === "connecting" || s.status === "closed"
            ? { ...s, status: "open" }
            : s,
        );
        return;
      }

      // WS already open for this terminal? We're done — live events keep
      // streaming. If the chat was resumed in a new terminal, close the old
      // socket and attach below.
      const existingTerminalId = wsTerminalIdsRef.current.get(chatId);
      if (
        wsMapRef.current.has(chatId) &&
        existingTerminalId === terminalSessionId
      ) {
        return;
      }
      const existingWs = wsMapRef.current.get(chatId);
      if (existingWs) existingWs.close();

      const ingest = (text: string) => {
        const buf =
          (lineBuffersRef.current.get(chatId) ?? "") + stripAnsi(text);
        const parts = buf.split("\n");
        const remainder = parts.pop() ?? "";
        lineBuffersRef.current.set(chatId, remainder);
        const newBlocks: Block[] = [];
        let nextStatus: "running" | "open" | null = null;
        const seenForSession = seenUuidsRef.current.get(chatId);
        for (const line of parts) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("{")) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(trimmed);
          } catch {
            continue;
          }
          const key = eventDedupKey(parsed);
          if (key && seenForSession?.has(key)) continue;
          if (key) seenForSession?.add(key);
          const transition = statusFromEvent(parsed);
          if (transition) nextStatus = transition;
          newBlocks.push(...eventToBlocks(parsed));
        }
        if (newBlocks.length > 0 || nextStatus) {
          updatePanel(chatId, (s) => ({
            ...s,
            blocks:
              newBlocks.length > 0 ? [...s.blocks, ...newBlocks] : s.blocks,
            status: nextStatus && s.status !== "error" ? nextStatus : s.status,
          }));
        }
      };

      const wsUrl = `${localApiBase.replace(/^http/, "ws")}/terminals/${terminalSessionId}/stream`;
      const ws = new WebSocket(wsUrl);
      wsMapRef.current.set(chatId, ws);
      wsTerminalIdsRef.current.set(chatId, terminalSessionId);

      ws.addEventListener("open", () => {
        // Gap-fill: any events written between the initial hydrate and the
        // WS being ready (or by another browser concurrently) get pulled in
        // here. dedup via seen-event set keeps this idempotent.
        void hydrateSession(chatId);
        // Don't override 'running' set by hydration — claude may still be
        // streaming after a refresh and we want to keep the indicator.
        updatePanel(chatId, (s) =>
          s.status === "running" ? s : { ...s, status: "open" },
        );
      });
      ws.addEventListener("message", (event) => {
        const data = event.data;
        if (typeof data === "string") {
          ingest(data);
        } else if (data instanceof Blob) {
          void data.text().then(ingest);
        } else {
          ingest(String(data));
        }
      });
      ws.addEventListener("close", () => {
        if (wsMapRef.current.get(chatId) !== ws) return;
        wsMapRef.current.delete(chatId);
        wsTerminalIdsRef.current.delete(chatId);
        activeTerminalIdsRef.current.delete(chatId);
        updatePanel(chatId, (s) =>
          s.status === "error" ? s : { ...s, status: "open" },
        );
      });
      ws.addEventListener("error", () => {
        updatePanel(chatId, (s) => ({
          ...s,
          status: "error",
          error: "WebSocket error",
        }));
      });
    },
    [hydrateSession, localApiBase, updatePanel],
  );

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${localApiBase}/api/chats`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { chats: ChatSummary[] };
      data.chats.sort((a, b) => (a.lastActivity < b.lastActivity ? 1 : -1));
      const activeIds = new Map<string, string>();
      for (const chat of data.chats) {
        if (chat.activeTerminalSessionId) {
          activeIds.set(chat.chatId, chat.activeTerminalSessionId);
        }
      }
      activeTerminalIdsRef.current = activeIds;
      setChats(data.chats);
      setListError(null);
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    }
  }, [localApiBase]);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  useEffect(() => {
    if (selectedId) void ensureConnection(selectedId);
  }, [selectedId, ensureConnection]);

  // Re-hydrate when the tab becomes visible again so background tabs catch
  // up on anything that landed while they were hidden, and on window focus
  // (covers cases where visibilitychange doesn't fire).
  useEffect(() => {
    if (!selectedId) return;
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      void ensureConnection(selectedId);
    };
    const onFocus = () => void ensureConnection(selectedId);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
    };
  }, [selectedId, ensureConnection]);

  // Periodic catch-up: re-fetch the persisted log every few seconds while a
  // session is selected. dedup keeps it cheap on the client side and ensures
  // we converge to the server's NDJSON even if WS chunks were dropped or
  // the initial hydrate raced.
  useEffect(() => {
    if (!selectedId) return;
    const interval = window.setInterval(() => {
      void hydrateSession(selectedId);
    }, 3000);
    return () => window.clearInterval(interval);
  }, [selectedId, hydrateSession]);

  useEffect(() => {
    return () => {
      for (const ws of wsMapRef.current.values()) {
        ws.close();
      }
      wsMapRef.current.clear();
      wsTerminalIdsRef.current.clear();
      activeTerminalIdsRef.current.clear();
      lineBuffersRef.current.clear();
    };
  }, []);

  const newChat = useCallback(async () => {
    try {
      const res = await fetch(`${localApiBase}/api/chats`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as {
        chatId: string;
        terminalSessionId: string;
      };
      activeTerminalIdsRef.current.set(body.chatId, body.terminalSessionId);
      setSelectedId(body.chatId);
      void ensureConnection(body.chatId);
      void refresh();
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    }
  }, [ensureConnection, localApiBase, refresh, setSelectedId]);

  const sendMessage = useCallback(
    async (chatId: string) => {
      const text = (drafts.get(chatId) ?? "").trim();
      if (!text) return;
      const cur = panelStates.get(chatId) ?? INITIAL_PANEL_STATE;
      if (cur.status !== "open" && cur.status !== "running") return;
      try {
        const res = await fetch(`${localApiBase}/api/chats/${chatId}/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: text }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as {
          terminalSessionId: string;
        };
        activeTerminalIdsRef.current.set(chatId, body.terminalSessionId);
        setDrafts((prev) => {
          const next = new Map(prev);
          next.set(chatId, "");
          return next;
        });
        updatePanel(chatId, (s) => ({ ...s, status: "running" }));
        void ensureConnection(chatId);
        void refresh();
      } catch (err) {
        updatePanel(chatId, (s) => ({
          ...s,
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    },
    [drafts, ensureConnection, localApiBase, panelStates, refresh, updatePanel],
  );

  const setDraft = useCallback((sessionId: string, value: string) => {
    setDrafts((prev) => {
      const next = new Map(prev);
      next.set(sessionId, value);
      return next;
    });
  }, []);

  const endChat = useCallback(
    async (chatId: string) => {
      const ws = wsMapRef.current.get(chatId);
      if (ws) {
        ws.close();
        wsMapRef.current.delete(chatId);
      }
      wsTerminalIdsRef.current.delete(chatId);
      activeTerminalIdsRef.current.delete(chatId);
      try {
        await fetch(`${localApiBase}/api/chats/${chatId}/terminal`, {
          method: "DELETE",
        });
      } catch {
        // best-effort
      }
      updatePanel(chatId, (s) => ({ ...s, status: "open" }));
      void refresh();
    },
    [localApiBase, refresh, updatePanel],
  );

  return (
    <DebugContext.Provider value={debug}>
      <div className="flex h-screen min-h-0 flex-col bg-background text-foreground">
        <div className="flex min-h-0 flex-1">
          <aside className="flex w-48 shrink-0 flex-col bg-off-black text-off-white sm:w-64 lg:w-72">
            <div className="flex h-11 shrink-0 items-center justify-between gap-2 px-2.5">
              <div className="flex min-w-0 items-center gap-2 text-sm font-semibold">
                <MessageSquare className="size-4 shrink-0" aria-hidden />
                <span className="truncate">Chats</span>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  title="New chat"
                  aria-label="New chat"
                  onClick={() => void newChat()}
                >
                  <Plus className="size-3.5" aria-hidden />
                </Button>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  title="Refresh chats"
                  aria-label="Refresh chats"
                  onClick={() => void refresh()}
                >
                  <RefreshCw className="size-3.5" aria-hidden />
                </Button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {listError ? (
                <div className="px-2 py-3 text-xs text-destructive">
                  {listError}
                </div>
              ) : chats.length === 0 ? (
                <div className="px-2 py-3 text-xs text-muted-foreground">
                  No chats
                </div>
              ) : (
                <div className="flex flex-col gap-1">
                  {chats.map((s) => {
                    const active = s.chatId === selectedId;
                    const subtitle =
                      s.claudeSessionIds[s.claudeSessionIds.length - 1] ??
                      s.activeTerminalSessionId ??
                      "No session yet";
                    return (
                      <button
                        key={s.chatId}
                        type="button"
                        onClick={() => setSelectedId(s.chatId)}
                        aria-current={active ? "true" : undefined}
                        className={cls(
                          "grid w-full grid-cols-[auto_minmax(0,1fr)] gap-x-2 rounded-lg border border-transparent px-2.5 py-2 text-left text-sm outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-3 focus-visible:ring-sidebar-ring/50",
                          active &&
                            "border-sidebar-border bg-sidebar-accent text-sidebar-accent-foreground shadow-sm",
                        )}
                      >
                        <span
                          className={cls(
                            "mt-1 size-2 rounded-full",
                            STATUS_DOT[s.status],
                          )}
                          title={s.status}
                          aria-hidden
                        />
                        <span className="min-w-0">
                          <span className="block min-w-0 truncate font-medium">
                            {shortId(s.chatId)}
                          </span>
                          <span className="mt-1 flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                            <Clock3 className="size-3 shrink-0" aria-hidden />
                            <span className="min-w-0 truncate">
                              {formatRelative(s.lastActivity)}
                            </span>
                            <span aria-hidden>·</span>
                            <span className="shrink-0 capitalize">
                              {s.status}
                            </span>
                          </span>
                          <span className="mt-0.5 block min-w-0 truncate text-xs text-muted-foreground">
                            {shortId(subtitle)}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            {sidebarFooter ? (
              <div className="flex shrink-0 items-center gap-1 p-2">
                <div className="min-w-0 flex-1">{sidebarFooter}</div>
                <Button
                  type="button"
                  size="icon-sm"
                  variant={debug ? "secondary" : "ghost"}
                  title={debug ? "Disable debug mode" : "Enable debug mode"}
                  aria-label="Toggle debug mode"
                  aria-pressed={debug}
                  onClick={() => setDebug((v) => !v)}
                >
                  <Bug className="size-3.5" aria-hidden />
                </Button>
              </div>
            ) : (
              <div className="flex shrink-0 items-center justify-end p-2">
                <Button
                  type="button"
                  size="icon-sm"
                  variant={debug ? "secondary" : "ghost"}
                  title={debug ? "Disable debug mode" : "Enable debug mode"}
                  aria-label="Toggle debug mode"
                  aria-pressed={debug}
                  onClick={() => setDebug((v) => !v)}
                >
                  <Bug className="size-3.5" aria-hidden />
                </Button>
              </div>
            )}
          </aside>
          <div className="relative min-w-0 flex-1">
            {selectedId ? (
              <ChatPanel
                sessionId={selectedId}
                state={panelStates.get(selectedId) ?? INITIAL_PANEL_STATE}
                draft={drafts.get(selectedId) ?? ""}
                onDraftChange={(v) => setDraft(selectedId, v)}
                onSend={() => void sendMessage(selectedId)}
                onEndChat={() => void endChat(selectedId)}
              />
            ) : (
              <EmptyState onNew={() => void newChat()} />
            )}
          </div>
        </div>
      </div>
    </DebugContext.Provider>
  );
}

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="grid h-full place-items-center bg-off-white p-8 text-center text-off-black">
      <div className="flex flex-col items-center gap-3">
        <MessageSquare className="size-8 text-muted-foreground" aria-hidden />
        <p className="text-sm text-muted-foreground">
          Select a chat from the sidebar, or start a new one.
        </p>
        <Button onClick={onNew}>
          <Plus className="size-4" aria-hidden /> New chat
        </Button>
      </div>
    </div>
  );
}

type PanelStatus = "connecting" | "open" | "running" | "closed" | "error";

function AssistantMarkdown({ text }: { text: string }) {
  const plugins = useMemo(() => STREAMDOWN_PLUGINS, []);
  return (
    <Streamdown
      mode="streaming"
      parseIncompleteMarkdown
      plugins={plugins}
      className="prose-sm max-w-none"
    >
      {text}
    </Streamdown>
  );
}

function BlockBody({ block }: { block: Block }) {
  switch (block.kind) {
    case "system":
      return null;
    case "thinking":
      return (
        <div className="flex gap-2 rounded-md border border-dashed border-border bg-background/40 px-3 py-2 text-xs text-muted-foreground">
          <Brain className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <p className="whitespace-pre-wrap italic">{block.text}</p>
        </div>
      );
    case "text":
      return (
        <div className="py-2 text-sm">
          <AssistantMarkdown text={block.text} />
        </div>
      );
    case "user_text":
      return (
        <div className="flex w-full gap-2 rounded-md border border-border bg-background/60 px-3 py-2 text-sm">
          <User
            className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <p className="min-w-0 whitespace-pre-wrap">{block.text}</p>
        </div>
      );
    case "tool_use":
      return (
        <div className="rounded-md border border-border bg-background/60 px-3 py-2 text-xs">
          <div className="mb-1 flex items-center gap-1.5 font-medium">
            <Wrench className="size-3.5" aria-hidden />
            <span>{block.name || "tool"}</span>
          </div>
          <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[11px] text-muted-foreground">
            {formatJson(block.input)}
          </pre>
        </div>
      );
    case "tool_result": {
      const truncated =
        block.content.length > 1500
          ? `${block.content.slice(0, 1500)}\n… (${block.content.length - 1500} more chars)`
          : block.content;
      return (
        <div
          className={cls(
            "rounded-md border px-3 py-2 text-xs",
            block.isError
              ? "border-destructive/40 bg-destructive/10"
              : "border-border bg-background/40",
          )}
        >
          <div className="mb-1 font-medium text-muted-foreground">
            {block.isError ? "tool error" : "tool result"}
          </div>
          <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[11px]">
            {truncated}
          </pre>
        </div>
      );
    }
    case "result":
      return (
        <div className="flex flex-col gap-1">
          {block.result ? (
            block.isError ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                <p className="whitespace-pre-wrap">{block.result}</p>
              </div>
            ) : (
              <div className="py-2 text-sm">
                <AssistantMarkdown text={block.result} />
              </div>
            )
          ) : null}
          <div
            className={cls(
              "flex items-center gap-1.5 text-[10px] text-muted-foreground",
              block.isError && "text-destructive",
            )}
          >
            <CheckCircle2 className="size-3" aria-hidden />
            <span>
              {block.isError ? "error · " : ""}
              {formatDurationMs(block.durationMs)}
            </span>
          </div>
        </div>
      );
  }
}

function SystemBlockView({
  block,
}: {
  block: Extract<Block, { kind: "system" }>;
}) {
  const debug = useContext(DebugContext);
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="inline-flex w-fit items-center gap-1 rounded-md px-1 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        {expanded ? (
          <ChevronDown className="size-3.5" aria-hidden />
        ) : (
          <ChevronRight className="size-3.5" aria-hidden />
        )}
        <span>session started</span>
      </button>
      {expanded ? (
        <div className="ml-1.5 flex flex-col gap-1 border-l-2 border-border pl-3 text-xs text-muted-foreground">
          <div>
            model <code className="rounded bg-muted px-1">{block.model}</code>
          </div>
          <div className="min-w-0">
            cwd{" "}
            <code className="rounded bg-muted px-1 break-all">{block.cwd}</code>
          </div>
          {debug ? (
            <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-[11px]">
              {formatJson(block.raw)}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function BlockView({ block }: { block: Block }) {
  const debug = useContext(DebugContext);
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="group relative">
      <BlockBody block={block} />
      {debug ? (
        <>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-label={expanded ? "Hide raw JSON" : "Show raw JSON"}
            className="mt-1 inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
          >
            {expanded ? (
              <ChevronDown className="size-3" aria-hidden />
            ) : (
              <ChevronRight className="size-3" aria-hidden />
            )}
            <span>raw</span>
          </button>
          {expanded ? (
            <pre className="mt-1 overflow-x-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-[11px] text-muted-foreground">
              {formatJson(block.raw)}
            </pre>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

interface BlockGroup {
  id: string;
  systemBlock: Block | null;
  systemHasDownstream: boolean;
  userMessage: Block | null;
  intermediates: Block[];
  finalText: Block | null;
  resultBlock: Block | null;
}

function groupBlocks(blocks: Block[]): BlockGroup[] {
  const groups: BlockGroup[] = [];
  let current: BlockGroup | null = null;
  let groupCounter = 0;
  const startGroup = (id?: string): BlockGroup => {
    const g: BlockGroup = {
      id: id ? `${id}-${groupCounter++}` : `g${groupCounter++}`,
      systemBlock: null,
      systemHasDownstream: false,
      userMessage: null,
      intermediates: [],
      finalText: null,
      resultBlock: null,
    };
    groups.push(g);
    return g;
  };
  for (const block of blocks) {
    if (block.kind === "system") {
      if (
        current?.userMessage &&
        !current.systemBlock &&
        current.intermediates.length === 0 &&
        !current.finalText &&
        !current.resultBlock
      ) {
        current.systemBlock = block;
        continue;
      }
      current = startGroup(eventUuid(block.raw) ?? block.sessionId);
      current.systemBlock = block;
      continue;
    }
    if (!current) current = startGroup();
    if (block.kind === "user_text") {
      if (
        current.userMessage ||
        current.resultBlock ||
        current.intermediates.length > 0
      ) {
        current = startGroup();
      }
      current.userMessage = block;
    } else if (block.kind === "result") {
      if (current.systemBlock?.kind === "system") {
        current.systemHasDownstream = true;
      }
      current.resultBlock = block;
    } else {
      if (current.systemBlock?.kind === "system") {
        current.systemHasDownstream = true;
      }
      current.intermediates.push(block);
    }
  }
  for (const g of groups) {
    if (g.resultBlock?.kind === "result" && g.resultBlock.result) continue;
    if (g.intermediates.some((b) => b.kind === "tool_use")) continue;
    for (let i = g.intermediates.length - 1; i >= 0; i--) {
      const b = g.intermediates[i];
      if (b.kind === "text") {
        g.finalText = b;
        g.intermediates.splice(i, 1);
        break;
      }
    }
  }
  return groups;
}

type ToolUseBlock = Extract<Block, { kind: "tool_use" }>;
type ToolResultBlock = Extract<Block, { kind: "tool_result" }>;

function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  for (const k of [
    "file_path",
    "command",
    "pattern",
    "path",
    "url",
    "query",
    "description",
  ]) {
    const v = obj[k];
    if (typeof v === "string" && v) {
      return v.length > 80 ? `${v.slice(0, 80)}…` : v;
    }
  }
  return "";
}

function ToolCallView({
  toolUse,
  toolResult,
}: {
  toolUse: ToolUseBlock;
  toolResult: ToolResultBlock | null;
}) {
  const [expanded, setExpanded] = useState(false);

  // No result yet — show the live tool_use box so the user sees activity.
  if (!toolResult) return <BlockView block={toolUse} />;

  const summary = summarizeToolInput(toolUse.input);
  return (
    <div
      className={cls(
        "rounded-md border bg-background/60",
        toolResult.isError ? "border-destructive/40" : "border-border",
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs hover:bg-muted/50"
      >
        {expanded ? (
          <ChevronDown className="size-3.5 shrink-0" aria-hidden />
        ) : (
          <ChevronRight className="size-3.5 shrink-0" aria-hidden />
        )}
        <Wrench className="size-3.5 shrink-0" aria-hidden />
        <span className="font-medium">{toolUse.name || "tool"}</span>
        {summary ? (
          <span className="min-w-0 truncate text-muted-foreground">
            {summary}
          </span>
        ) : null}
        {toolResult.isError ? (
          <span className="ml-auto shrink-0 text-destructive">error</span>
        ) : null}
      </button>
      {expanded ? (
        <div className="flex flex-col gap-2 border-t border-border px-3 py-2">
          <BlockView block={toolUse} />
          <BlockView block={toolResult} />
        </div>
      ) : null}
    </div>
  );
}

function GroupView({
  group,
  isFirst,
}: {
  group: BlockGroup;
  isFirst: boolean;
}) {
  const debug = useContext(DebugContext);
  const toolCallCount = group.intermediates.filter(
    (b) => b.kind === "tool_use",
  ).length;
  const messageCount = group.intermediates.filter(
    (b) => b.kind === "thinking" || b.kind === "text",
  ).length;
  const isDone = !!group.resultBlock || !!group.finalText;
  const showIntermediates =
    group.intermediates.length > 0 && (toolCallCount > 0 || !isDone);
  const showSystemBlock =
    group.systemBlock?.kind === "system" &&
    (!debug || isFirst) &&
    (debug || !group.systemHasDownstream);
  const summaryParts = [
    toolCallCount > 0
      ? `${toolCallCount} tool ${toolCallCount === 1 ? "call" : "calls"}`
      : "",
    messageCount > 0
      ? `${messageCount} ${messageCount === 1 ? "message" : "messages"}`
      : "",
  ].filter(Boolean);
  // Force-expand while the turn is streaming; auto-collapse on the
  // streaming -> done transition, then respect manual toggles.
  const [manualExpanded, setManualExpanded] = useState(false);
  const expanded = !isDone ? true : manualExpanded;
  const wasDoneRef = useRef(isDone);
  useEffect(() => {
    if (!wasDoneRef.current && isDone) setManualExpanded(false);
    wasDoneRef.current = isDone;
  }, [isDone]);

  // Walk intermediates and pair adjacent tool_use + tool_result so the pair
  // can be rendered as a single collapsible item.
  const items: Array<
    | { kind: "block"; block: Block }
    | {
        kind: "tool_call";
        toolUse: ToolUseBlock;
        toolResult: ToolResultBlock | null;
      }
  > = [];
  for (let i = 0; i < group.intermediates.length; i++) {
    const b = group.intermediates[i];
    if (b.kind === "tool_use") {
      const next = group.intermediates[i + 1];
      if (next && next.kind === "tool_result") {
        items.push({ kind: "tool_call", toolUse: b, toolResult: next });
        i++;
        continue;
      }
      items.push({ kind: "tool_call", toolUse: b, toolResult: null });
      continue;
    }
    items.push({ kind: "block", block: b });
  }

  return (
    <div className="flex flex-col gap-3">
      {group.userMessage ? <BlockView block={group.userMessage} /> : null}
      {showSystemBlock && group.systemBlock?.kind === "system" ? (
        <SystemBlockView block={group.systemBlock} />
      ) : null}
      {showIntermediates ? (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => setManualExpanded((v) => !v)}
            disabled={!isDone}
            aria-expanded={expanded}
            className="inline-flex w-fit items-center gap-1 rounded-md py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
          >
            {expanded ? (
              <ChevronDown className="size-3.5" aria-hidden />
            ) : (
              <ChevronRight className="size-3.5" aria-hidden />
            )}
            <span>{summaryParts.join(", ")}</span>
          </button>
          {expanded ? (
            <div className="ml-1.5 flex flex-col gap-2 border-l-2 border-border pl-3">
              {items.map((item, i) => {
                if (item.kind === "tool_call") {
                  const key = `tc-${eventUuid(item.toolUse.raw) ?? i}-${item.toolUse.name}`;
                  return (
                    <ToolCallView
                      key={key}
                      toolUse={item.toolUse}
                      toolResult={item.toolResult}
                    />
                  );
                }
                const key = `b-${eventUuid(item.block.raw) ?? i}-${item.block.kind}`;
                return <BlockView key={key} block={item.block} />;
              })}
            </div>
          ) : null}
        </div>
      ) : null}
      {group.finalText ? <BlockView block={group.finalText} /> : null}
      {group.resultBlock ? <BlockView block={group.resultBlock} /> : null}
    </div>
  );
}

function ChatPanel({
  sessionId,
  state,
  draft,
  onDraftChange,
  onSend,
  onEndChat,
}: {
  sessionId: string;
  state: PanelState;
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  onEndChat: () => void;
}) {
  const { blocks, status, error } = state;
  const outputRef = useRef<HTMLDivElement | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll-to-bottom should re-fire on every blocks/sessionId change
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [blocks, sessionId]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onSend();
    }
  };

  const canSend =
    Boolean(draft.trim()) && (status === "open" || status === "running");

  return (
    <div className="flex h-full min-h-0 flex-col bg-off-white text-off-black">
      <header className="flex h-11 shrink-0 items-center justify-between gap-2 px-3">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <span className="font-mono text-muted-foreground">{sessionId}</span>
          <span className="text-xs text-muted-foreground">· {status}</span>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onEndChat}>
          End session
        </Button>
      </header>
      <div ref={outputRef} className="min-h-0 flex-1 overflow-auto p-3">
        {blocks.length === 0 ? (
          status === "running" ? (
            <DotmSquare1 size={16} dotSize={2} />
          ) : (
            <p className="text-sm text-muted-foreground">
              {status === "connecting"
                ? "Connecting..."
                : "No messages yet. Send something to start."}
            </p>
          )
        ) : (
          <div className="flex flex-col gap-3">
            {groupBlocks(blocks).map((g, i) => (
              <GroupView key={g.id} group={g} isFirst={i === 0} />
            ))}
            {status === "running" ? (
              <DotmSquare1 size={16} dotSize={2} />
            ) : null}
          </div>
        )}
      </div>
      {error ? (
        <p className="shrink-0 border-t border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex shrink-0 items-end gap-2 p-3">
        <textarea
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Type a message. ⌘/Ctrl+Enter to send."
          disabled={status === "connecting" || status === "error"}
          className="field-sizing-content min-h-12 flex-1 rounded-lg border border-input bg-white px-2.5 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
        />
        <Button onClick={onSend} disabled={!canSend}>
          Send
        </Button>
      </div>
    </div>
  );
}
