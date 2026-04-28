import {
  Brain,
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
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "./components/ui/button";

const DEFAULT_LOCAL_API_BASE = "https://local-api.localhost";

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

type SessionStatus = "running" | "exited" | "expired" | "closed";

interface SessionSummary {
  sessionId: string;
  status: SessionStatus;
  cwd: string;
  shell: string;
  created: string;
  lastActivity: string;
  timeout: number | null;
  streamUrl: string;
}

const STATUS_DOT: Record<SessionStatus, string> = {
  running: "bg-emerald-500",
  exited: "bg-muted-foreground",
  expired: "bg-amber-500",
  closed: "bg-muted-foreground",
};

function shortId(id: string): string {
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

export type ChatPageProps = {
  localApiBase?: string;
  sidebarFooter?: ReactNode;
};

export function ChatPage({
  localApiBase = DEFAULT_LOCAL_API_BASE,
  sidebarFooter,
}: ChatPageProps) {
  return (
    <ChatShell localApiBase={localApiBase} sidebarFooter={sidebarFooter} />
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
  sidebarFooter,
}: {
  localApiBase: string;
  sidebarFooter?: ReactNode;
}) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [panelStates, setPanelStates] = useState<Map<string, PanelState>>(
    () => new Map(),
  );
  const [drafts, setDrafts] = useState<Map<string, string>>(() => new Map());
  const wsMapRef = useRef<Map<string, WebSocket>>(new Map());
  const lineBuffersRef = useRef<Map<string, string>>(new Map());
  const seenUuidsRef = useRef<Map<string, Set<string>>>(new Map());

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
    async (sessionId: string) => {
      let seen = seenUuidsRef.current.get(sessionId);
      if (!seen) {
        seen = new Set<string>();
        seenUuidsRef.current.set(sessionId, seen);
      }
      try {
        const res = await fetch(
          `${localApiBase}/api/terminals/${sessionId}/events`,
        );
        if (!res.ok) return;
        const body = (await res.json()) as { events?: unknown[] };
        const newBlocks: Block[] = [];
        let nextStatus: "running" | "open" | null = null;
        for (const ev of body.events ?? []) {
          const uuid = eventUuid(ev);
          if (uuid && seen.has(uuid)) continue;
          if (uuid) seen.add(uuid);
          const transition = statusFromEvent(ev);
          if (transition) nextStatus = transition;
          newBlocks.push(...eventToBlocks(ev));
        }
        if (newBlocks.length > 0 || nextStatus) {
          updatePanel(sessionId, (s) => ({
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
    async (sessionId: string) => {
      // Always make sure per-session state containers exist so hydrate can
      // record uuids and append blocks even on re-selection.
      setPanelStates((prev) => {
        if (prev.has(sessionId)) return prev;
        const next = new Map(prev);
        next.set(sessionId, INITIAL_PANEL_STATE);
        return next;
      });
      if (!lineBuffersRef.current.has(sessionId)) {
        lineBuffersRef.current.set(sessionId, "");
      }
      if (!seenUuidsRef.current.has(sessionId)) {
        seenUuidsRef.current.set(sessionId, new Set<string>());
      }

      // Always hydrate on (re)entry so the user sees the latest persisted
      // log. dedup via the seen-uuid set keeps this idempotent.
      await hydrateSession(sessionId);

      // WS already open? We're done — live events keep streaming.
      if (wsMapRef.current.has(sessionId)) return;

      const ingest = (text: string) => {
        const buf =
          (lineBuffersRef.current.get(sessionId) ?? "") + stripAnsi(text);
        const parts = buf.split("\n");
        const remainder = parts.pop() ?? "";
        lineBuffersRef.current.set(sessionId, remainder);
        const newBlocks: Block[] = [];
        let nextStatus: "running" | "open" | null = null;
        const seenForSession = seenUuidsRef.current.get(sessionId);
        for (const line of parts) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("{")) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(trimmed);
          } catch {
            continue;
          }
          const uuid = eventUuid(parsed);
          if (uuid && seenForSession?.has(uuid)) continue;
          if (uuid) seenForSession?.add(uuid);
          const transition = statusFromEvent(parsed);
          if (transition) nextStatus = transition;
          newBlocks.push(...eventToBlocks(parsed));
        }
        if (newBlocks.length > 0 || nextStatus) {
          updatePanel(sessionId, (s) => ({
            ...s,
            blocks:
              newBlocks.length > 0 ? [...s.blocks, ...newBlocks] : s.blocks,
            status: nextStatus && s.status !== "error" ? nextStatus : s.status,
          }));
        }
      };

      const wsUrl = `${localApiBase.replace(/^http/, "ws")}/terminals/${sessionId}/stream`;
      const ws = new WebSocket(wsUrl);
      wsMapRef.current.set(sessionId, ws);

      ws.addEventListener("open", () => {
        // Gap-fill: any events written between the initial hydrate and the
        // WS being ready (or by another browser concurrently) get pulled in
        // here. dedup via seen-uuid set keeps this idempotent.
        void hydrateSession(sessionId);
        // Don't override 'running' set by hydration — claude may still be
        // streaming after a refresh and we want to keep the indicator.
        updatePanel(sessionId, (s) =>
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
        wsMapRef.current.delete(sessionId);
        updatePanel(sessionId, (s) =>
          s.status === "error" ? s : { ...s, status: "closed" },
        );
      });
      ws.addEventListener("error", () => {
        updatePanel(sessionId, (s) => ({
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
      const res = await fetch(`${localApiBase}/api/terminals`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { sessions: SessionSummary[] };
      data.sessions.sort((a, b) => (a.lastActivity < b.lastActivity ? 1 : -1));
      setSessions(data.sessions);
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
      lineBuffersRef.current.clear();
    };
  }, []);

  const newChat = useCallback(async () => {
    try {
      const res = await fetch(`${localApiBase}/api/terminals`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cols: 120, rows: 40 }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { sessionId: string };
      setSelectedId(body.sessionId);
      void ensureConnection(body.sessionId);
      void refresh();
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    }
  }, [ensureConnection, localApiBase, refresh]);

  const sendMessage = useCallback(
    async (sessionId: string) => {
      const text = (drafts.get(sessionId) ?? "").trim();
      if (!text) return;
      const cur = panelStates.get(sessionId) ?? INITIAL_PANEL_STATE;
      if (cur.status !== "open" && cur.status !== "running") return;
      try {
        const res = await fetch(
          `${localApiBase}/api/terminals/${sessionId}/chat`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ message: text }),
          },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setDrafts((prev) => {
          const next = new Map(prev);
          next.set(sessionId, "");
          return next;
        });
        updatePanel(sessionId, (s) => ({ ...s, status: "running" }));
      } catch (err) {
        updatePanel(sessionId, (s) => ({
          ...s,
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    },
    [drafts, localApiBase, panelStates, updatePanel],
  );

  const setDraft = useCallback((sessionId: string, value: string) => {
    setDrafts((prev) => {
      const next = new Map(prev);
      next.set(sessionId, value);
      return next;
    });
  }, []);

  const endChat = useCallback(
    async (sessionId: string) => {
      const ws = wsMapRef.current.get(sessionId);
      if (ws) {
        ws.close();
        wsMapRef.current.delete(sessionId);
      }
      lineBuffersRef.current.delete(sessionId);
      seenUuidsRef.current.delete(sessionId);
      setPanelStates((prev) => {
        if (!prev.has(sessionId)) return prev;
        const next = new Map(prev);
        next.delete(sessionId);
        return next;
      });
      setDrafts((prev) => {
        if (!prev.has(sessionId)) return prev;
        const next = new Map(prev);
        next.delete(sessionId);
        return next;
      });
      if (selectedId === sessionId) setSelectedId(null);
      try {
        await fetch(`${localApiBase}/api/terminals/${sessionId}`, {
          method: "DELETE",
        });
      } catch {
        // best-effort
      }
      void refresh();
    },
    [localApiBase, refresh, selectedId],
  );

  return (
    <div className="flex h-screen min-h-0 flex-col bg-background text-foreground">
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-48 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground sm:w-64 lg:w-72">
          <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-sidebar-border px-2.5">
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
            ) : sessions.length === 0 ? (
              <div className="px-2 py-3 text-xs text-muted-foreground">
                No chats
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                {sessions.map((s) => {
                  const active = s.sessionId === selectedId;
                  return (
                    <button
                      key={s.sessionId}
                      type="button"
                      onClick={() => setSelectedId(s.sessionId)}
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
                          {shortId(s.sessionId)}
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
                          {s.cwd}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          {sidebarFooter ? (
            <div className="shrink-0 border-t border-sidebar-border p-2">
              {sidebarFooter}
            </div>
          ) : null}
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
  );
}

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="grid h-full place-items-center p-8 text-center">
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

function BlockBody({ block }: { block: Block }) {
  switch (block.kind) {
    case "system":
      return (
        <div className="rounded-md border border-border bg-background/60 px-3 py-2 text-xs text-muted-foreground">
          <span className="font-mono">▶ session</span> · model{" "}
          <code className="rounded bg-muted px-1">{block.model}</code> · cwd{" "}
          <code className="rounded bg-muted px-1">{block.cwd}</code>
        </div>
      );
    case "thinking":
      return (
        <div className="flex gap-2 rounded-md border border-dashed border-border bg-background/40 px-3 py-2 text-xs text-muted-foreground">
          <Brain className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <p className="whitespace-pre-wrap italic">{block.text}</p>
        </div>
      );
    case "text":
      return (
        <div className="rounded-md border border-border bg-card px-3 py-2 text-sm">
          <p className="whitespace-pre-wrap">{block.text}</p>
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
        <div
          className={cls(
            "flex items-center gap-2 rounded-md border px-3 py-2 text-xs",
            block.isError
              ? "border-destructive/40 bg-destructive/10 text-destructive"
              : "border-border bg-background/60 text-muted-foreground",
          )}
        >
          <CheckCircle2 className="size-3.5" aria-hidden />
          <span>
            {block.isError ? "error" : "done"} · {Math.round(block.durationMs)}
            ms
            {block.cost > 0 ? ` · $${block.cost.toFixed(4)}` : ""}
          </span>
        </div>
      );
  }
}

function BlockView({ block }: { block: Block }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="group relative">
      <BlockBody block={block} />
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
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <span className="font-mono text-muted-foreground">{sessionId}</span>
          <span className="text-xs text-muted-foreground">· {status}</span>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onEndChat}>
          End chat
        </Button>
      </header>
      <div
        ref={outputRef}
        className="min-h-0 flex-1 overflow-auto bg-muted/30 p-3"
      >
        {blocks.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {status === "connecting"
              ? "Connecting..."
              : status === "running"
                ? "Waiting for response..."
                : "No messages yet. Send something to start."}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {blocks.map((b, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: blocks are append-only so index is stable
              <BlockView key={i} block={b} />
            ))}
            {status === "running" ? (
              <p className="text-xs text-muted-foreground italic">
                streaming...
              </p>
            ) : null}
          </div>
        )}
      </div>
      {error ? (
        <p className="shrink-0 border-t border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex shrink-0 items-end gap-2 border-t border-border p-3">
        <textarea
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Type a message. ⌘/Ctrl+Enter to send."
          disabled={status === "connecting" || status === "error"}
          className="field-sizing-content min-h-12 flex-1 rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
        />
        <Button onClick={onSend} disabled={!canSend}>
          Send
        </Button>
      </div>
    </div>
  );
}
